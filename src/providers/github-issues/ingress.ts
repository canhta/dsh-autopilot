import { Buffer } from 'node:buffer'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { type TrackerIngressDelivery, TrackerProviderError, type TrackerProviderIngressRequest } from '../../tracker.js'
import { webhookBodySchema } from './schemas.js'
import { type GitHubIssuesSettings, requireIngressConfiguredSettings } from './settings.js'

const MAX_WEBHOOK_BYTES = 256 * 1024
const ALLOWED_EVENTS = new Set(['issues', 'issue_comment', 'issue_dependencies', 'ping'])
const ALLOWED_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  issues: new Set(['opened', 'edited', 'deleted', 'transferred', 'reopened', 'closed', 'labeled', 'unlabeled']),
  issue_comment: new Set(['created', 'edited', 'deleted']),
  issue_dependencies: new Set(['blocked_by_added', 'blocked_by_removed', 'blocking_added', 'blocking_removed']),
}

/**
 * Authenticate one detached GitHub webhook without retaining it or writing externally. Rejects malformed,
 * unauthenticated, misrouted, or cancelled input with no partial effect.
 */
export async function verifyGitHubIssuesIngress(
  ctx: Context,
  snapshot: Readonly<GitHubIssuesSettings>,
  request: TrackerProviderIngressRequest,
): Promise<TrackerIngressDelivery> {
  const { method, headers, body, signal } = request
  signal.throwIfAborted()
  if (method !== 'POST') {
    throw new TrackerProviderError('invalid-response', 'GitHub Issues webhook method must be POST')
  }
  const contentType = singleHeader(headers, 'content-type')
  if (contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new TrackerProviderError('invalid-response', 'GitHub Issues webhook content type must be application/json')
  }
  if (body.byteLength === 0 || body.byteLength > MAX_WEBHOOK_BYTES) {
    throw new TrackerProviderError('invalid-response', 'GitHub Issues webhook payload size is invalid')
  }
  const signature = singleHeader(headers, 'x-hub-signature-256')
  const delivery = singleHeader(headers, 'x-github-delivery')
  const event = singleHeader(headers, 'x-github-event')
  if (signature === undefined || !/^sha256=[a-f0-9]{64}$/.test(signature)) {
    throw new TrackerProviderError('authentication', 'GitHub Issues webhook signature is missing or invalid')
  }
  if (delivery === undefined || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(delivery)) {
    throw new TrackerProviderError('invalid-response', 'GitHub Issues webhook delivery id is missing or invalid')
  }
  if (event === undefined || !ALLOWED_EVENTS.has(event)) {
    throw new TrackerProviderError('invalid-response', 'GitHub Issues webhook event is missing or unsupported')
  }
  const config = requireIngressConfiguredSettings(snapshot)
  const resolved = await ctx.credentials.resolve(credentialRef(config.webhookSecretRef))
  signal.throwIfAborted()
  if (resolved === undefined) {
    throw new TrackerProviderError('authentication', 'GitHub Issues webhook secret reference is not configured')
  }
  const expected = createHmac('sha256', resolved.value).update(body).digest()
  const actual = Buffer.from(signature.slice('sha256='.length), 'hex')
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    throw new TrackerProviderError('authentication', 'GitHub Issues webhook signature did not match')
  }
  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown
  } catch {
    throw new TrackerProviderError('invalid-response', 'GitHub Issues webhook payload is malformed')
  }
  const parsed = webhookBodySchema.safeParse(payload)
  if (!parsed.success) throw new TrackerProviderError('invalid-response', 'GitHub Issues webhook payload is malformed')
  if (event !== 'ping' && !ALLOWED_ACTIONS[event]?.has(parsed.data.action ?? '')) {
    throw new TrackerProviderError('invalid-response', 'GitHub Issues webhook action is missing or unsupported')
  }
  if (String(parsed.data.repository.id) !== config.repositoryId) {
    throw new TrackerProviderError('invalid-response', 'GitHub Issues webhook repository did not match the binding')
  }
  const identity = createHash('sha256').update(`${config.repositoryId}\0${delivery}`).digest('hex')
  return { deliveryId: `github-issues:${identity}` }
}

function singleHeader(headers: readonly { name: string; value: string }[], requestedName: string): string | undefined {
  const values = headers.filter((header) => header.name.toLowerCase() === requestedName).map((header) => header.value)
  if (values.length > 1) {
    throw new TrackerProviderError('invalid-response', `GitHub Issues webhook ${requestedName} header is duplicated`)
  }
  return values[0]
}
