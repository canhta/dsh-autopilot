import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { NotificationProviderError, type NotificationReceipt } from '../notification.js'

const MAX_RESPONSE_BYTES = 64 * 1024

export interface HttpNotificationDestination {
  readonly url: string
  readonly authorizationCredentialRef: string
}

export function validateDestinationUrl(value: string, subject: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`${subject} must be an absolute URL`)
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new TypeError(`${subject} must use HTTPS without embedded credentials or a fragment`)
  }
}

export async function authorizationHeader(
  ctx: Context,
  reference: string,
): Promise<Record<'authorization', string> | Record<string, never>> {
  if (reference === '') return {}
  const resolved = await ctx.credentials.resolve(credentialRef(reference))
  if (resolved === undefined) {
    throw new NotificationProviderError('authentication', 'notification authorization credential is unavailable')
  }
  return { authorization: `Bearer ${resolved.value}` }
}

export async function postNotification(
  destination: HttpNotificationDestination,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
  signal: AbortSignal,
  responseBody: 'ignore' | 'bounded',
): Promise<{ response: Response; text: string }> {
  signal.throwIfAborted()
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = AbortSignal.any([signal, timeout])
  let response: Response
  try {
    response = await fetch(destination.url, {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      signal: combined,
    })
  } catch {
    signal.throwIfAborted()
    if (timeout.aborted) {
      throw new NotificationProviderError('ambiguous-acknowledgement', 'notification request timed out after dispatch')
    }
    throw new NotificationProviderError('transient', 'notification destination could not be reached')
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    throwResponseError(response)
  }
  if (responseBody === 'ignore') {
    void response.body?.cancel().catch(() => undefined)
    return { response, text: '' }
  }
  let text: string
  try {
    text = await boundedResponseText(response, combined)
  } catch (error) {
    signal.throwIfAborted()
    if (timeout.aborted) {
      throw new NotificationProviderError(
        'ambiguous-acknowledgement',
        'notification acknowledgement timed out after response headers',
      )
    }
    if (error instanceof NotificationProviderError) throw error
    throw new NotificationProviderError('transient', 'notification response could not be read')
  }
  return { response, text }
}

function throwResponseError(response: Response): never {
  const retryAfterMs = retryDelay(response.headers.get('retry-after'))
  if (response.status === 401)
    throw new NotificationProviderError('authentication', 'notification authentication failed')
  if (response.status === 403) throw new NotificationProviderError('permission', 'notification permission was denied')
  if (response.status === 429) {
    throw new NotificationProviderError('rate-limit', 'notification destination rate limited delivery', retryAfterMs)
  }
  if (response.status >= 500) {
    throw new NotificationProviderError(
      'transient',
      'notification destination was temporarily unavailable',
      retryAfterMs,
    )
  }
  throw new NotificationProviderError('permanent-rejection', 'notification destination rejected the event')
}

export function acknowledgedReceipt(prefix: string, eventId: string, response: Response): NotificationReceipt {
  const externalId = response.headers.get('x-request-id')?.trim()
  return {
    receiptId: `${prefix}:${externalId === undefined || externalId === '' ? eventId : externalId}`.slice(0, 512),
    receivedAt: new Date().toISOString(),
  }
}

async function boundedResponseText(response: Response, signal: AbortSignal): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel()
    throw new NotificationProviderError('invalid-response', 'notification response exceeded its safety bound')
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new NotificationProviderError('invalid-response', 'notification response exceeded its safety bound')
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function retryDelay(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1_000, 60 * 60 * 1_000)
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return undefined
  return Math.max(1_000, Math.min(timestamp - Date.now(), 60 * 60 * 1_000))
}
