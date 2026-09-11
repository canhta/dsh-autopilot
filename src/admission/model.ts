import type { SessionId } from '@deepseek-ai/dsh-session'
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

export interface RunExecutionSnapshot {
  readonly attempt: number
  readonly sessionId: SessionId
  readonly targetRepository: string
  readonly baseBranch: string
  readonly worktreePath: string
  readonly branch: string
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
  readonly reason: 'host-restart' | 'session-unavailable' | 'workspace-unavailable' | 'worktree-mismatch'
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
    }
  | { readonly kind: 'blocked'; readonly summary: string; readonly evidence: string[] }
  | { readonly kind: 'failed'; readonly summary: string; readonly evidence: string[] }

export interface TerminalRun extends Omit<QueuedRun, 'state'> {
  readonly state: 'publishing' | 'blocked' | 'failed'
  readonly execution: RunExecutionSnapshot
  readonly budget: RunBudgetSnapshot
  readonly outcome: ExecutionOutcome
  readonly completedAt: string
}

export type AutopilotRun = QueuedRun | PausedQueuedRun | ImplementingRun | PausingRun | PausedActiveRun | TerminalRun

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

export interface ReconcileResult extends AdmissionSnapshot {
  decisions: readonly AdmissionDecision[]
}

export interface SchedulerDisableResult {
  readonly snapshot: AdmissionSnapshot
  readonly pausingRunIds: readonly RunId[]
}
