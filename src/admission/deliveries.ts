import { createHash } from 'node:crypto'
import type { AutopilotSettings } from '../config.js'
import { type NotificationEvent, notificationDestinationId, notificationProviderId } from '../notification.js'
import type { TrackerOutboundDelivery } from '../tracker.js'
import { MAX_OUTCOME_TEXT_BYTES } from './constants.js'
import type { AutopilotRun, DeliveryRecord, PublicationIntent, TerminalRun, VerificationResult } from './model.js'
import { truncateUtf8 } from './policy.js'

type LifecycleEvent = Omit<NotificationEvent, 'runUrl' | 'issueUrl'>

export function appendLifecycleDeliveries(
  run: AutopilotRun,
  settings: AutopilotSettings,
  type: NotificationEvent['type'],
  runRevision: number,
  timestamp: string,
): DeliveryRecord[] {
  const eventId = stableId('event', run.runId, type, String(runRevision))
  const event = lifecycleEvent(run, type, eventId, timestamp)
  const deliveries = structuredClone(run.deliveries).map((delivery) => {
    if (delivery.kind !== 'tracker-projection' || ['succeeded', 'retired'].includes(delivery.status)) return delivery
    const { exhaustedFrom: _exhaustedFrom, nextRetryAt: _nextRetryAt, owner: _owner, ...withoutOwner } = delivery
    return { ...withoutOwner, status: 'retired' as const }
  })
  const report = trackerDelivery(run, event, runRevision, 'report')
  const projection = trackerDelivery(run, event, runRevision, 'projection')
  deliveries.push(recordForTracker(run, eventId, report), recordForTracker(run, eventId, projection))
  for (const subscription of settings.notificationSubscriptions) {
    if (!subscription.events.includes(type)) continue
    const providerId = notificationProviderId(subscription.providerId)
    const destinationId = notificationDestinationId(subscription.destinationId)
    deliveries.push({
      ...recordBase(stableId('delivery', eventId, providerId, destinationId), eventId),
      kind: 'notification',
      providerId,
      destinationId,
      payload: {
        ...event,
        summary:
          subscription.summaryDisclosure === 'full'
            ? event.summary
            : `${run.displayKey} ${type}; open the validated run link for details.`,
        runUrl: renderUrl(settings.runUrlTemplate, '{runId}', run.runId),
        issueUrl: renderUrl(settings.issueUrlTemplate, '{displayKey}', run.displayKey),
      },
    })
  }
  return deliveries
}

export function publicationIntent(run: TerminalRun): PublicationIntent {
  if (run.state !== 'publishing' || run.outcome.kind !== 'verified' || run.execution.git === undefined) {
    throw new Error('publication intent requires a verified publishing run with exact Git facts')
  }
  const marker = `<!-- dsh-autopilot:run:${run.runId} -->`
  return {
    id: `publication:${run.runId}`,
    revision: 1,
    providerId: run.execution.codeHost.providerId,
    bindingId: run.execution.codeHost.bindingId,
    repositoryId: run.execution.codeHost.repositoryId,
    repository: run.execution.codeHost.repository,
    baseBranch: run.execution.baseBranch,
    headBranch: run.execution.branch,
    baseHead: run.execution.git.baseHead,
    localHead: run.execution.git.head,
    marker,
    title: run.outcome.suggestedPullRequest.title,
    body: pullRequestBody(run, marker),
    status: 'pending',
    attempts: 0,
  }
}

function lifecycleEvent(
  run: AutopilotRun,
  type: NotificationEvent['type'],
  eventId: string,
  timestamp: string,
): LifecycleEvent {
  const outcome = 'outcome' in run ? run.outcome : undefined
  const pullRequestUrl = 'publication' in run ? run.publication?.receipt?.url : undefined
  const tokens = 'budget' in run && !run.budget.usageUncertain ? run.budget.settledTokens : undefined
  return {
    version: 1,
    eventId,
    runId: run.runId,
    timestamp,
    type,
    issueIdentity: `${run.providerId}:${run.bindingId}:${run.issueId}`,
    displayKey: run.displayKey,
    summary: outcome?.summary ?? `${run.displayKey} ${type}`,
    ...(type === 'blocked'
      ? { actionNeeded: 'Resolve the reported blocker and apply a new attributable human readiness transition.' }
      : {}),
    ...(pullRequestUrl === undefined ? {} : { pullRequestUrl }),
    usage:
      tokens === undefined
        ? { kind: 'unknown' }
        : {
            kind: 'provider',
            tokens,
          },
  }
}

function trackerDelivery(
  run: AutopilotRun,
  event: LifecycleEvent,
  runRevision: number,
  kind: TrackerOutboundDelivery['kind'],
): TrackerOutboundDelivery {
  const deliveryId = stableId('tracker', event.eventId, kind)
  if (kind === 'projection') {
    return {
      kind,
      deliveryId,
      eventId: event.eventId,
      bindingId: run.bindingId,
      issueId: run.issueId,
      displayKey: run.displayKey,
      readinessGeneration: run.readinessGeneration,
      runRevision,
      desiredState: event.type === 'started' ? 'implementing' : event.type,
    }
  }
  return {
    kind,
    deliveryId,
    eventId: event.eventId,
    bindingId: run.bindingId,
    issueId: run.issueId,
    displayKey: run.displayKey,
    body: trackerReport(run, event),
  }
}

function trackerReport(run: AutopilotRun, event: LifecycleEvent): string {
  const lines = [
    `Generated by dsh-autopilot (AI-assisted execution).`,
    `<!-- dsh-autopilot:event:${event.eventId} -->`,
    '',
    `Run ${run.runId} ${event.type}: ${event.summary}`,
  ]
  if ('outcome' in run) {
    lines.push('', 'Evidence:', ...run.outcome.evidence.map((entry) => `- ${entry}`))
  }
  if (event.pullRequestUrl !== undefined) lines.push('', `Pull request: ${event.pullRequestUrl}`)
  if (event.actionNeeded !== undefined) lines.push('', `Action needed: ${event.actionNeeded}`)
  return truncateUtf8(lines.join('\n'), 32 * 1024)
}

function renderUrl(template: string, placeholder: string, value: string): string {
  const url = new URL(template.replace(placeholder, encodeURIComponent(value)))
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new TypeError('notification links require validated HTTPS templates without credentials')
  }
  return url.href
}

function pullRequestBody(run: TerminalRun, marker: string): string {
  if (run.outcome.kind !== 'verified') throw new Error('pull-request body requires a verified outcome')
  const checks = run.outcome.verification.map(formatVerification)
  const suffix = [
    '',
    '---',
    `Tracker: ${run.displayKey}`,
    `Autopilot run: ${run.runId}`,
    '',
    'Verification:',
    ...checks,
    '',
    marker,
  ].join('\n')
  const maximumSuggestionBytes = 32 * 1024 - Buffer.byteLength(suffix)
  if (maximumSuggestionBytes < 1) throw new RangeError('publication metadata exceeds its durable bound')
  return `${truncateUtf8(run.outcome.suggestedPullRequest.body, maximumSuggestionBytes)}${suffix}`
}

function formatVerification(result: VerificationResult): string {
  const reason = result.reason === undefined ? '' : ` (${result.reason})`
  return `- ${result.status}: \`${result.command.replaceAll('`', "'")}\` — ${result.summary}${reason}`
}

function recordForTracker(run: AutopilotRun, eventId: string, payload: TrackerOutboundDelivery): DeliveryRecord {
  const base = recordBase(stableId('delivery', payload.deliveryId), eventId)
  return payload.kind === 'report'
    ? { ...base, kind: 'tracker-report', providerId: run.providerId, payload }
    : { ...base, kind: 'tracker-projection', providerId: run.providerId, payload }
}

function recordBase(id: string, eventId: string) {
  return { id, eventId, revision: 1, status: 'pending' as const, attempts: 0 }
}

function stableId(prefix: 'event' | 'delivery' | 'tracker', ...parts: string[]): string {
  return `${prefix}:${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 40)}`
}

export function sanitizeDeliveryError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  return (
    truncateUtf8(value.replaceAll(/https?:\/\/[^\s]+/g, '[redacted-url]'), MAX_OUTCOME_TEXT_BYTES) || 'delivery failed'
  )
}
