import { Buffer } from 'node:buffer'
import type { z } from 'zod'
import { TrackerProviderError } from '../../tracker.js'
import type { JiraSettings } from './settings.js'

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_OPERATION_RESPONSE_BYTES = 8 * 1024 * 1024

export type JiraRequest = (path: string, init?: RequestInit) => Promise<unknown>

export function createJiraRequest(
  fetchImplementation: typeof fetch,
  config: JiraSettings,
  token: string,
  signal: AbortSignal,
): JiraRequest {
  const authorization = `Basic ${Buffer.from(`${config.email}:${token}`).toString('base64')}`
  let consumedResponseBytes = 0
  return async (path, init = {}) => {
    const timeoutSignal = AbortSignal.timeout(config.requestTimeoutMs)
    try {
      const response = await fetchImplementation(
        `https://api.atlassian.com/ex/jira/${encodeURIComponent(config.cloudId)}${path}`,
        {
          ...init,
          signal: AbortSignal.any([signal, timeoutSignal]),
          headers: {
            accept: 'application/json',
            authorization,
            ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
        },
      )
      if (!response.ok) throw jiraHttpError(response)
      const remaining = MAX_OPERATION_RESPONSE_BYTES - consumedResponseBytes
      const result = await readBoundedJson(response, Math.min(MAX_RESPONSE_BYTES, remaining))
      consumedResponseBytes += result.byteLength
      return result.value
    } catch (error) {
      if (error instanceof TrackerProviderError) throw error
      if (timeoutSignal.aborted && !signal.aborted) {
        throw new TrackerProviderError('timeout', 'Jira request timed out')
      }
      throw new TrackerProviderError('transient', 'Jira request failed')
    }
  }
}

export function parseProviderResponse<T>(schema: z.ZodType<T>, value: unknown, subject: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new TrackerProviderError('invalid-response', `${subject} was malformed`)
  return parsed.data
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<{ value: unknown; byteLength: number }> {
  if (maxBytes <= 0) {
    await response.body?.cancel()
    throw new TrackerProviderError('invalid-response', 'Jira operation exceeded the response safety bound')
  }
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel()
    throw new TrackerProviderError('invalid-response', 'Jira response exceeded the configured safety bound')
  }
  if (response.body === null) throw new TrackerProviderError('invalid-response', 'Jira returned an empty response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new TrackerProviderError('invalid-response', 'Jira response exceeded the configured safety bound')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) as unknown, byteLength: total }
  } catch {
    throw new TrackerProviderError('invalid-response', 'Jira returned malformed JSON')
  }
}

function jiraHttpError(response: Response): TrackerProviderError {
  if (response.status === 401) return new TrackerProviderError('authentication', 'Jira rejected authentication')
  if (response.status === 403) return new TrackerProviderError('permission', 'Jira denied the requested operation')
  if (response.status === 404) return new TrackerProviderError('not-found', 'Jira resource was not found')
  if (response.status === 409) return new TrackerProviderError('conflict', 'Jira reported a conflicting change')
  if (response.status === 429) {
    return new TrackerProviderError('rate-limit', 'Jira rate limit was reached', retryAfterMs(response.headers))
  }
  if (response.status >= 500) return new TrackerProviderError('transient', 'Jira is temporarily unavailable')
  return new TrackerProviderError('invalid-response', `Jira rejected the request with HTTP ${String(response.status)}`)
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get('retry-after')
  if (value === null) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const time = Date.parse(value)
  return Number.isNaN(time) ? undefined : Math.max(0, time - Date.now())
}
