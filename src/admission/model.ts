import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CodeHostBindingId, CodeHostProviderId, CodeHostRepositoryId, PullRequestReceipt } from '../code-host.js'
import type { NotificationEvent } from '../notification.js'
import type {
  ReadinessGeneration,
  TrackerBindingId,
  TrackerCommentId,
  TrackerIssueId,
  TrackerProviderId,
} from '../tracker.js'

declare const runIdBrand: unique symbol
export type RunId = string & { readonly [runIdBrand]: true }

export type AdmissionSource = 'manual' | 'scheduled' | 'startup' | 'webhook'
export type SchedulerMode = 'enabled' | 'draining' | 'disabled'

export interface SchedulerSnapshot {
  readonly mode: SchedulerMode
  readonly changedAt: string
}

export interface ReconcileRequest {
  source: AdmissionSource
  deliveryId?: string
  signal?: AbortSignal
}

/** Bounded core failure proving that tracker ingress was not durably accepted. */
export class AdmissionIngressError extends Error {
  /** Construct a caller-safe ingress failure; this operation has no side effects or cancellation point. */
  constructor(readonly code: 'queue-capacity' | 'not-accepting') {
    super(
      code === 'queue-capacity'
        ? 'Admission queue capacity deferred eligible tracker work.'
        : 'Admission is not accepting tracker ingress.',
    )
    this.name = 'AdmissionIngressError'
  }
}

export type AdmissionRejectionReason =
  | 'missing-brief'
  | 'ambiguous-brief'
  | 'invalid-brief'
  | 'brief-too-large'
  | 'summary-too-large'
  | 'not-ready'
  | 'dependencies-incomplete'
  | 'dependency-unknown'
  | 'human-readiness-required'

export type AdmissionDecision =
  | { displayKey: string; outcome: 'queued' | 'duplicate' }
  | { displayKey: string; outcome: 'deferred'; reason: 'queue-capacity' }
  | { displayKey: string; outcome: 'rejected'; reason: AdmissionRejectionReason }

export interface AgentBriefSnapshot {
  readonly commentId: TrackerCommentId
  readonly updatedAt: string
  readonly digest: string
  readonly content: string
}

export interface QueuedRun {
  readonly runId: RunId
  readonly providerId: TrackerProviderId
  readonly bindingId: TrackerBindingId
  readonly issueId: TrackerIssueId
  readonly displayKey: string
  readonly summary: string
  readonly priorityRank: number
  readonly readinessGeneration: ReadinessGeneration
  readonly brief: AgentBriefSnapshot
  readonly deliveries: DeliveryRecord[]
  readonly state: 'queued'
  readonly queueClass: 'new' | 'resumption'
  readonly queuedAt: string
  readonly queueSequence: number
}

export interface PausedQueuedRun extends Omit<QueuedRun, 'state' | 'queueClass'> {
  readonly state: 'paused'
  readonly queueClass: 'resumption'
  readonly pause: {
    readonly kind: 'queued'
    readonly reason: 'operator'
    readonly operatorHold: true
    readonly continuationTarget: 'implementing'
    readonly pausedAt: string
  }
}

export type ActivePauseReason = 'operator' | 'scheduler' | 'service-withdrawal'
export type ActiveResumeAuthorization = 'operator' | 'scheduler'

export interface ActivePauseSnapshot {
  readonly kind: 'active'
  readonly reason: ActivePauseReason
  readonly operatorHold: boolean
  readonly continuationTarget: 'implementing'
  readonly requestedAt: string
  readonly interruptedOperation: 'agent-turn'
}

/** Exact DSH composition captured for a run before it leaves the queue. */
export interface AgentExecutionComposition {
  readonly presetId: string
  readonly presetFingerprint: string
  readonly permission: {
    readonly presetId: string
    readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
    readonly approval: 'never'
  }
  readonly model: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string | undefined
  }
}

export interface RunExecutionSnapshot {
  readonly attempt: number
  readonly sessionId: SessionId
  readonly targetRepository: string
  readonly baseBranch: string
  readonly worktreePath: string
  readonly branch: string
  /** Absent only on durable records created before native DSH composition was captured. */
  readonly agent?: AgentExecutionComposition | undefined
  readonly codeHost: {
    readonly providerId: CodeHostProviderId
    readonly bindingId: CodeHostBindingId
    readonly repositoryId: CodeHostRepositoryId
    readonly repository: string
    readonly allowWorkflowChanges: boolean
  }
  readonly startedAt: string
  readonly git?: GitExecutionSnapshot | undefined
  readonly recovery?: RunRecoverySnapshot | undefined
}

export interface GitExecutionSnapshot {
  readonly baseHead: string
  readonly head: string
  readonly status: string
}

export interface RunRecoverySnapshot {
  readonly kind: 'required'
  readonly reason:
    | 'host-restart'
    | 'composition-unavailable'
    | 'session-unavailable'
    | 'workspace-unavailable'
    | 'worktree-mismatch'
  readonly interruptedAt: string
}

export type ActiveRecoveryReason = Exclude<RunRecoverySnapshot['reason'], 'host-restart'>

export interface RunBudgetSnapshot {
  readonly capTokens: number
  readonly allowanceTokens: number
  readonly reservedTokens: number
  readonly settledTokens: number
  readonly usageUncertain: boolean
  readonly usageUncertaintyReason?: string | undefined
}

export interface ImplementingRun extends Omit<QueuedRun, 'state'> {
  readonly state: 'implementing'
  readonly execution: RunExecutionSnapshot
  readonly budget: RunBudgetSnapshot
}

export interface PausingRun extends Omit<ImplementingRun, 'state'> {
  readonly state: 'pausing'
  readonly pause: ActivePauseSnapshot
}

export interface PausedActiveRun extends Omit<ImplementingRun, 'state'> {
  readonly state: 'paused'
  readonly pause: ActivePauseSnapshot & {
    readonly pausedAt: string
    readonly lastCompletedPhase: 'agent-quiescent'
  }
}

export type ExecutionOutcome =
  | {
      readonly kind: 'verified'
      readonly summary: string
      readonly evidence: string[]
      readonly reportedGit: Pick<GitExecutionSnapshot, 'head' | 'status'>
      readonly verification: VerificationResult[]
      readonly suggestedPullRequest: SuggestedPullRequest
    }
  | { readonly kind: 'blocked'; readonly summary: string; readonly evidence: string[] }
  | { readonly kind: 'failed'; readonly summary: string; readonly evidence: string[] }

export interface TerminalRun extends Omit<QueuedRun, 'state'> {
  readonly state: 'publishing' | 'completed' | 'blocked' | 'failed'
  readonly execution: RunExecutionSnapshot
  readonly budget: RunBudgetSnapshot
  readonly outcome: ExecutionOutcome
  readonly completedAt: string
  readonly publication?: PublicationIntent | undefined
}

export type RunCancellationSource = 'queued' | 'paused-queued' | 'paused-active' | 'blocked'

export interface RunCancellationSnapshot<Source extends RunCancellationSource = RunCancellationSource> {
  readonly requestId: string
  readonly cancelledAt: string
  readonly from: Source
}

export interface CancelledQueuedRun extends Omit<QueuedRun, 'state'> {
  readonly state: 'cancelled'
  readonly cancellation: RunCancellationSnapshot<'queued'>
}

export interface CancelledPausedQueuedRun extends Omit<PausedQueuedRun, 'state'> {
  readonly state: 'cancelled'
  readonly cancellation: RunCancellationSnapshot<'paused-queued'>
}

export interface CancelledPausedActiveRun extends Omit<PausedActiveRun, 'state'> {
  readonly state: 'cancelled'
  readonly cancellation: RunCancellationSnapshot<'paused-active'>
}

export interface CancelledBlockedRun extends Omit<TerminalRun, 'state' | 'outcome'> {
  readonly state: 'cancelled'
  readonly outcome: Extract<ExecutionOutcome, { kind: 'blocked' }>
  readonly cancellation: RunCancellationSnapshot<'blocked'>
}

export type CancelledRun =
  | CancelledQueuedRun
  | CancelledPausedQueuedRun
  | CancelledPausedActiveRun
  | CancelledBlockedRun

export type AutopilotRun =
  | QueuedRun
  | PausedQueuedRun
  | ImplementingRun
  | PausingRun
  | PausedActiveRun
  | TerminalRun
  | CancelledRun

export type RunUsageSettlement =
  | { readonly kind: 'known'; readonly tokens: number }
  | { readonly kind: 'uncertain'; readonly reason: string }

export interface AdmissionBudgetSnapshot {
  readonly reservedTokens: number
  readonly settledTokens: number
  readonly usageUncertain: boolean
}

export interface AdmissionSnapshot {
  revision: number
  runs: readonly AutopilotRun[]
  acceptedIngress: readonly string[]
  budget: AdmissionBudgetSnapshot
  scheduler: SchedulerSnapshot
}

export interface VerificationResult {
  readonly command: string
  readonly status: 'passed' | 'failed' | 'skipped'
  readonly summary: string
  readonly reason?: string | undefined
}

export interface SuggestedPullRequest {
  readonly title: string
  readonly body: string
}

export interface PublicationIntent {
  readonly id: string
  readonly revision: number
  readonly providerId: CodeHostProviderId
  readonly bindingId: CodeHostBindingId
  readonly repositoryId: CodeHostRepositoryId
  readonly repository: string
  readonly baseBranch: string
  readonly headBranch: string
  readonly baseHead: string
  readonly localHead: string
  readonly marker: string
  readonly title: string
  readonly body: string
  readonly status: 'pending' | 'in-flight' | 'uncertain' | 'retryable-failure' | 'exhausted' | 'failed' | 'succeeded'
  readonly attempts: number
  readonly owner?: string | undefined
  readonly nextRetryAt?: string | undefined
  readonly exhaustedFrom?: 'uncertain' | 'retryable-failure' | undefined
  readonly lastError?: string | undefined
  readonly branchReceipt?: { readonly remoteHead: string; readonly receivedAt: string } | undefined
  readonly receipt?: PullRequestReceipt | undefined
}

export interface DeliveryRecordBase {
  readonly id: string
  readonly eventId: string
  readonly revision: number
  readonly status:
    | 'pending'
    | 'in-flight'
    | 'uncertain'
    | 'retryable-failure'
    | 'exhausted'
    | 'permanent-failure'
    | 'succeeded'
    | 'retired'
  readonly attempts: number
  readonly owner?: string | undefined
  readonly nextRetryAt?: string | undefined
  readonly exhaustedFrom?: 'uncertain' | 'retryable-failure' | undefined
  readonly lastError?: string | undefined
  readonly receiptId?: string | undefined
  readonly receivedAt?: string | undefined
}

export type DeliveryRecord =
  | (DeliveryRecordBase & {
      readonly kind: 'tracker-report'
      readonly providerId: TrackerProviderId
      readonly payload: Extract<import('../tracker.js').TrackerOutboundDelivery, { kind: 'report' }>
    })
  | (DeliveryRecordBase & {
      readonly kind: 'tracker-projection'
      readonly providerId: TrackerProviderId
      readonly payload: Extract<import('../tracker.js').TrackerOutboundDelivery, { kind: 'projection' }>
    })
  | (DeliveryRecordBase & {
      readonly kind: 'notification'
      readonly providerId: import('../notification.js').NotificationProviderId
      readonly destinationId: import('../notification.js').NotificationDestinationId
      readonly payload: NotificationEvent
    })

export interface ReconcileResult extends AdmissionSnapshot {
  decisions: readonly AdmissionDecision[]
}

export interface SchedulerDisableResult {
  readonly snapshot: AdmissionSnapshot
  readonly pausingRunIds: readonly RunId[]
}
