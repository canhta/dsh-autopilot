import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { SessionId as sessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { AutopilotSettings } from '../config.js'
import type { TrackerComment, TrackerIssueSnapshot, TrackerProviderId } from '../tracker.js'
import { ID_PATTERN, MAX_OUTCOME_TEXT_BYTES, MAX_STATE_BYTES, MAX_SUMMARY_BYTES, textEncoder } from './constants.js'
import type {
  ActivePauseReason,
  ActivePauseSnapshot,
  ActiveResumeAuthorization,
  AdmissionRejectionReason,
  AgentBriefSnapshot,
  AutopilotRun,
  GitExecutionSnapshot,
  ImplementingRun,
  PausedActiveRun,
  PausedQueuedRun,
  PausingRun,
  QueuedRun,
  ReconcileRequest,
  RunExecutionSnapshot,
  RunId,
  RunUsageSettlement,
} from './model.js'

export interface EligibleIssue {
  issue: TrackerIssueSnapshot & { readiness: Extract<TrackerIssueSnapshot['readiness'], { kind: 'transition' }> }
  brief: AgentBriefSnapshot
}

export function activePause(reason: ActivePauseReason, requestedAt: string): ActivePauseSnapshot {
  return {
    kind: 'active',
    reason,
    operatorHold: reason === 'operator',
    continuationTarget: 'implementing',
    requestedAt,
    interruptedOperation: 'agent-turn',
  }
}

export function isPausedActiveRun(run: AutopilotRun | undefined): run is PausedActiveRun {
  return run?.state === 'paused' && run.pause.kind === 'active'
}

export function isPausedQueuedRun(run: AutopilotRun | undefined): run is PausedQueuedRun {
  return run?.state === 'paused' && run.pause.kind === 'queued'
}

export function validUsageSettlement(
  run: ImplementingRun | PausingRun,
  usage: RunUsageSettlement,
): usage is Extract<RunUsageSettlement, { kind: 'known' }> {
  return (
    usage.kind === 'known' &&
    Number.isSafeInteger(usage.tokens) &&
    usage.tokens >= 0 &&
    usage.tokens <= run.budget.reservedTokens &&
    run.budget.settledTokens + usage.tokens <= run.budget.capTokens
  )
}

export function usageUncertaintyReason(run: ImplementingRun | PausingRun, usage: RunUsageSettlement): string {
  return usage.kind === 'uncertain'
    ? truncateUtf8(usage.reason, MAX_OUTCOME_TEXT_BYTES) || 'provider did not supply a usage uncertainty reason'
    : `reported usage exceeded the reserved allowance of ${String(run.budget.reservedTokens)} tokens`
}

export function validateActiveResumeFacts(
  run: PausedActiveRun,
  observedGit: GitExecutionSnapshot,
  settings: AutopilotSettings,
  authorization: ActiveResumeAuthorization,
): void {
  if (authorization !== 'operator' && authorization !== 'scheduler') {
    throw new TypeError('active resume authorization must be operator or scheduler')
  }
  if (authorization === 'scheduler' && run.pause.operatorHold) {
    throw new Error(`run "${run.runId}" requires explicit operator resume`)
  }
  if (run.execution.recovery !== undefined) throw new Error(`run "${run.runId}" requires explicit recovery`)
  if (run.budget.usageUncertain) throw new Error(`run "${run.runId}" has uncertain token usage`)
  if (run.budget.settledTokens >= run.budget.capTokens) {
    throw new Error(`run "${run.runId}" has no retained token capacity`)
  }
  if (
    run.execution.targetRepository !== settings.targetRepository ||
    run.execution.baseBranch !== settings.targetBaseBranch ||
    run.execution.worktreePath !== join(settings.managedWorktreeRoot, run.runId)
  ) {
    throw new Error(`run "${run.runId}" retained execution routing no longer matches current policy`)
  }
  const retainedGit = run.execution.git
  if (
    retainedGit === undefined ||
    retainedGit.baseHead !== observedGit.baseHead ||
    retainedGit.head !== observedGit.head ||
    retainedGit.status !== observedGit.status
  ) {
    throw new Error(`run "${run.runId}" retained Git state changed and requires explicit recovery`)
  }
}

export function evaluateIssue(
  issue: TrackerIssueSnapshot,
  maxBriefBytes: number,
): EligibleIssue | { displayKey: string; reason: AdmissionRejectionReason } {
  if (textEncoder.encode(issue.summary).byteLength > MAX_SUMMARY_BYTES) {
    return { displayKey: issue.displayKey, reason: 'summary-too-large' }
  }
  if (!issue.isReady) return { displayKey: issue.displayKey, reason: 'not-ready' }
  const designated = issue.comments.filter(isDesignatedBrief)
  if (designated.length === 0) return { displayKey: issue.displayKey, reason: 'missing-brief' }
  if (designated.length > 1) return { displayKey: issue.displayKey, reason: 'ambiguous-brief' }
  const comment = designated[0]
  if (comment === undefined) return { displayKey: issue.displayKey, reason: 'missing-brief' }
  if (textEncoder.encode(comment.body).byteLength > maxBriefBytes) {
    return { displayKey: issue.displayKey, reason: 'brief-too-large' }
  }
  if (!hasRequiredBriefSections(comment.body)) {
    return { displayKey: issue.displayKey, reason: 'invalid-brief' }
  }
  if (issue.dependencies.some((dependency) => dependency.state === 'unknown')) {
    return { displayKey: issue.displayKey, reason: 'dependency-unknown' }
  }
  if (issue.dependencies.some((dependency) => dependency.state === 'not-completed')) {
    return { displayKey: issue.displayKey, reason: 'dependencies-incomplete' }
  }
  if (issue.readiness.kind !== 'transition' || issue.readiness.actorKind !== 'human') {
    return { displayKey: issue.displayKey, reason: 'human-readiness-required' }
  }
  if (Date.parse(issue.readiness.occurredAt) < Date.parse(comment.updatedAt)) {
    return { displayKey: issue.displayKey, reason: 'human-readiness-required' }
  }
  return {
    issue: issue as EligibleIssue['issue'],
    brief: {
      commentId: comment.id,
      updatedAt: comment.updatedAt,
      digest: createHash('sha256').update(comment.body).digest('hex'),
      content: comment.body,
    },
  }
}

function isDesignatedBrief(comment: TrackerComment): boolean {
  return /^#\s+Agent Brief\s*$/im.test(comment.body) && /^dsh-autopilot:brief:v1\s*$/im.test(comment.body)
}

function hasRequiredBriefSections(body: string): boolean {
  const matches = [...body.matchAll(/^##\s+(.+?)\s*$/gm)]
  const sections = new Map<string, string>()
  for (const [index, match] of matches.entries()) {
    const rawHeading = match[1]
    if (rawHeading === undefined || match.index === undefined) return false
    const heading = rawHeading.trim().toLocaleLowerCase('en-US')
    const contentStart = match.index + match[0].length
    const contentEnd = matches[index + 1]?.index ?? body.length
    sections.set(heading, body.slice(contentStart, contentEnd).trim())
  }
  return ['objective', 'in scope', 'acceptance criteria', 'constraints', 'context'].every(
    (heading) => (sections.get(heading)?.length ?? 0) > 0,
  )
}

export function runIdentity(providerId: TrackerProviderId, issue: EligibleIssue['issue']): string {
  if (issue.readiness.kind !== 'transition') throw new Error('eligible issue lost readiness transition')
  return JSON.stringify([providerId, issue.bindingId, issue.issueId, issue.readiness.generation])
}

export function runIdentityFromRun(
  run: Pick<AutopilotRun, 'providerId' | 'bindingId' | 'issueId' | 'readinessGeneration'>,
): string {
  return JSON.stringify([run.providerId, run.bindingId, run.issueId, run.readinessGeneration])
}

export function matchesRetainedIssue(
  run: Pick<AutopilotRun, 'providerId' | 'bindingId' | 'issueId' | 'readinessGeneration' | 'brief'>,
  providerId: TrackerProviderId,
  evaluation: EligibleIssue,
): boolean {
  return (
    run.providerId === providerId &&
    run.bindingId === evaluation.issue.bindingId &&
    run.issueId === evaluation.issue.issueId &&
    run.readinessGeneration === evaluation.issue.readiness.generation &&
    sameBrief(run.brief, evaluation.brief)
  )
}

export function sameRetainedRun(current: PausedQueuedRun, expected: PausedQueuedRun): boolean {
  return (
    current.runId === expected.runId &&
    runIdentityFromRun(current) === runIdentityFromRun(expected) &&
    sameBrief(current.brief, expected.brief)
  )
}

function sameBrief(left: AgentBriefSnapshot, right: AgentBriefSnapshot): boolean {
  return (
    left.commentId === right.commentId &&
    left.updatedAt === right.updatedAt &&
    left.digest === right.digest &&
    left.content === right.content
  )
}

export function runId(identity: string): RunId {
  return `run_${createHash('sha256').update(identity).digest('hex').slice(0, 32)}` as RunId
}

function queueClassRank(queueClass: QueuedRun['queueClass']): number {
  return queueClass === 'resumption' ? 0 : 1
}

export function compareQueuedRuns(left: QueuedRun, right: QueuedRun): number {
  return queueClassRank(left.queueClass) - queueClassRank(right.queueClass) || compareRunFacts(left, right)
}

export function compareSnapshotRuns(left: AutopilotRun, right: AutopilotRun): number {
  return snapshotGroup(left) - snapshotGroup(right) || compareRunFacts(left, right)
}

function snapshotGroup(run: AutopilotRun): number {
  if (run.state === 'implementing' || run.state === 'pausing') return 0
  if (run.state === 'queued') return queueClassRank(run.queueClass) + 1
  return 3
}

function compareRunFacts(left: AutopilotRun, right: AutopilotRun): number {
  return (
    left.priorityRank - right.priorityRank ||
    left.queueSequence - right.queueSequence ||
    left.displayKey.localeCompare(right.displayKey)
  )
}

export function executionFor(run: QueuedRun, settings: AutopilotSettings): RunExecutionSnapshot {
  const stableId = run.runId.slice('run_'.length)
  return {
    attempt: 1,
    sessionId: sessionId(`autopilot-${run.runId}`),
    targetRepository: settings.targetRepository,
    baseBranch: settings.targetBaseBranch,
    worktreePath: join(settings.managedWorktreeRoot, run.runId),
    branch: `dsh-autopilot/${stableId}`,
    startedAt: new Date().toISOString(),
  }
}

export function assertStateSize(state: object): void {
  if (textEncoder.encode(JSON.stringify(state)).byteLength > MAX_STATE_BYTES) {
    throw new RangeError(`admission state exceeds ${String(MAX_STATE_BYTES)} bytes`)
  }
}

export function boundedNonEmptyString(maxBytes: number, label: string): z.ZodString {
  return z
    .string()
    .min(1)
    .refine((value) => textEncoder.encode(value).byteLength <= maxBytes, {
      error: `${label} must not exceed ${String(maxBytes)} UTF-8 bytes`,
    })
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (textEncoder.encode(value).byteLength <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (textEncoder.encode(value.slice(0, middle)).byteLength <= maxBytes) low = middle
    else high = middle - 1
  }
  return value.slice(0, low)
}

export function validateRequest(request: ReconcileRequest): void {
  if (!['manual', 'scheduled', 'startup', 'webhook'].includes(request.source)) {
    throw new TypeError(`unsupported admission source "${String(request.source)}"`)
  }
  if (request.source === 'webhook' && request.deliveryId === undefined) {
    throw new TypeError('webhook reconciliation requires a provider-qualified delivery id')
  }
  if (request.deliveryId !== undefined && (request.deliveryId.length > 512 || !ID_PATTERN.test(request.deliveryId))) {
    throw new TypeError('delivery id must be provider-qualified and contain only stable id characters')
  }
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) {
    throw new TypeError('reconciliation signal must be an AbortSignal')
  }
}
