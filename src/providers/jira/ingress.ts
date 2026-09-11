import { Buffer } from 'node:buffer'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { type TrackerIngressDelivery, TrackerProviderError, type TrackerProviderIngressRequest } from '../../tracker.js'
import { webhookBodySchema } from './schemas.js'
import { type JiraSettings, requireIngressConfiguredSettings } from './settings.js'

const MAX_WEBHOOK_BYTES = 256 * 1024

export async function verifyJiraIngress(
  ctx: Context,
  snapshot: Readonly<JiraSettings>,
  request: TrackerProviderIngressRequest,
): Promise<TrackerIngressDelivery> {
  const { method, headers, body, signal } = request
  signal.throwIfAborted()
  if (method !== 'POST') {
    throw new TrackerProviderError('invalid-response', 'Jira webhook method must be POST')
  }
  const contentType = singleHeader(headers, 'content-type')
  if (contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new TrackerProviderError('invalid-response', 'Jira webhook content type must be application/json')
  }
  if (body.byteLength === 0 || body.byteLength > MAX_WEBHOOK_BYTES) {
    throw new TrackerProviderError('invalid-response', 'Jira webhook payload size is invalid')
  }
  const config = requireIngressConfiguredSettings(snapshot)
  const resolved = await ctx.credentials.resolve(credentialRef(config.webhookSecretRef))
  signal.throwIfAborted()
  if (resolved === undefined) {
    throw new TrackerProviderError('authentication', 'Jira webhook secret reference is not configured')
  }
  const signature = singleHeader(headers, 'x-hub-signature')
  if (signature === undefined || !/^sha256=[a-f0-9]{64}$/.test(signature)) {
    throw new TrackerProviderError('authentication', 'Jira webhook signature is missing or invalid')
  }
  const expected = createHmac('sha256', resolved.value).update(body).digest()
  const actual = Buffer.from(signature.slice('sha256='.length), 'hex')
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    throw new TrackerProviderError('authentication', 'Jira webhook signature did not match')
  }
  const identifier = singleHeader(headers, 'x-atlassian-webhook-identifier')
  if (identifier === undefined || !/^[A-Za-z0-9._:-]{1,256}$/.test(identifier)) {
    throw new TrackerProviderError('invalid-response', 'Jira webhook identifier is missing or invalid')
  }
  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown
  } catch {
    throw new TrackerProviderError('invalid-response', 'Jira webhook payload is malformed')
  }
  if (!webhookBodySchema.safeParse(payload).success) {
    throw new TrackerProviderError('invalid-response', 'Jira webhook payload is malformed')
  }
  const identity = createHash('sha256').update(`${config.cloudId}\0${identifier}`).digest('hex')
  return { deliveryId: `jira:${identity}` }
}

function singleHeader(headers: readonly { name: string; value: string }[], requestedName: string): string | undefined {
  const values = headers.filter((header) => header.name.toLowerCase() === requestedName).map((header) => header.value)
  if (values.length > 1) {
    throw new TrackerProviderError('invalid-response', `Jira webhook ${requestedName} header is duplicated`)
  }
  return values[0]
}
