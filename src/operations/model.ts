import type { Context } from '@deepseek-ai/cordis'
import type { AdmissionSnapshot, RunId } from '../admission.js'
import type { PullRequestDisposition } from './disposition.js'

export type CleanupRejection =
  | 'run-active'
  | 'run-paused'
  | 'run-publishing'
  | 'run-blocked'
  | 'run-failed'
  | 'external-intent-unresolved'
  | 'recovery-required'
  | 'ownership-unproven'
  | 'worktree-missing'
  | 'dirty-files'
  | 'untracked-files'
  | 'unpushed-commits'
  | 'pr-open'
  | 'pr-unknown'
  | 'pr-closed-unmerged'
  | 'retention-not-met'

export interface CleanupPreview {
  readonly previewId: string
  readonly runId: RunId
  readonly admissionRevision: number
  readonly worktreePath: string
  readonly branch: string
  readonly head?: string
  readonly dirtyFiles: readonly string[]
  readonly untrackedFiles: readonly string[]
  readonly unpushedCommits: number | 'unknown'
  readonly disposition: PullRequestDisposition
  readonly retentionReference?: string
  readonly retentionEligibleAt?: string
  readonly removableBytes: number | 'unknown'
  readonly retainedData: readonly ['run', 'session', 'audit']
  readonly eligible: boolean
  readonly rejections: readonly CleanupRejection[]
}

export interface RetainedWorktreeFact {
  readonly runId: RunId
  readonly path: string
  readonly state: 'managed' | 'missing' | 'unsafe'
  readonly detail?: string
}

export interface OrphanWorktreeFact {
  readonly path: string
  readonly branch?: string
  readonly state: 'orphan-reconciliation-required'
}

export interface MaintenanceAudit {
  readonly id: string
  readonly operationId?: string | undefined
  readonly at: string
  readonly kind: 'merge-observed' | 'cleanup-started' | 'cleanup-removed' | 'cleanup-rejected' | 'cleanup-recovered'
  readonly runId: RunId
  readonly worktreePath: string
  readonly outcome?: 'completed' | 'retry-required' | undefined
  readonly detail: string
}

export interface RecoveryParticipant {
  /** Reconcile this participant's durable unfinished effects; nonzero pending work keeps dispatch fenced. */
  reconcile(signal: AbortSignal): Promise<RecoveryParticipantFact>
}

export interface RecoveryParticipantFact {
  readonly pending: number
  readonly failure?: string
}

export interface OperationsHealth {
  readonly process: { status: 'alive'; owner: ReturnType<Context['runtimeOwner']['snapshot']> }
  readonly persistence: { status: 'ready' | 'unconfigured' | 'failed'; failure?: string }
  readonly recovery: {
    status: 'complete' | 'required' | 'failed'
    runIds: readonly RunId[]
    pendingCleanup: boolean
    participants: Readonly<Record<string, RecoveryParticipantFact>>
  }
  readonly integrations: {
    codeHost: { status: 'available' | 'unavailable' | 'failed'; failure?: string }
  }
  readonly admission: { status: 'permitted' | 'paused' | 'blocked'; mode: AdmissionSnapshot['scheduler']['mode'] }
}
