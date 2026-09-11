import { type Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { AutopilotSettings } from '../config.js'
import type { TrackerIngressRequest } from '../tracker.js'
import { STATE_KEY } from './constants.js'
import { ExecutionControl } from './execution-control.js'
import type {
  ActiveRecoveryReason,
  ActiveResumeAuthorization,
  AdmissionSnapshot,
  ExecutionOutcome,
  GitExecutionSnapshot,
  ImplementingRun,
  PausedActiveRun,
  PausedQueuedRun,
  PausingRun,
  QueuedRun,
  ReconcileRequest,
  ReconcileResult,
  RunId,
  RunUsageSettlement,
  SchedulerDisableResult,
  SchedulerMode,
  TerminalRun,
} from './model.js'
import { PauseControl } from './pause-control.js'
import type { AdmissionDependencies } from './ports.js'
import { reconcile as reconcileAdmission, reconcileIngress as reconcileTrackerIngress } from './reconciler.js'
import { ResumeControl } from './resume-control.js'
import { type AdmissionState, admissionDomainSpec, initialState, snapshotOf, stateSchema } from './state.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    admission: Admission
  }
}

export class Admission extends Service {
  static readonly inject = ['tracker', 'autopilotConfig', 'storageDomain']

  private state?: KvTable<typeof STATE_KEY, AdmissionState>

  constructor(ctx: Context) {
    super(ctx, 'admission')
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    const domain = await this.ctx.storageDomain.open(admissionDomainSpec)
    yield () => domain.close()
    this.state = domain.table('state')
    if (this.state.get(STATE_KEY) === undefined) {
      await this.state.put(STATE_KEY, initialState())
    } else {
      await this.markInterruptedRunsForRecovery()
    }
  }

  /**
   * Return a detached view with active work first, then queued work in dispatch order, then retained inactive runs.
   * Throws if the service has not finished initialization; it performs no I/O and has no cancellation point.
   */
  snapshot(): AdmissionSnapshot {
    const current = this.currentState()
    return snapshotOf(current)
  }

  /** Atomically change the admission/dequeue gate; rejects invalid modes or unsafe disable and has no cancellation point. */
  setSchedulerMode(mode: SchedulerMode): Promise<AdmissionSnapshot> {
    return this.pauseControl().setSchedulerMode(mode)
  }

  /**
   * Persist a draining/disabled transition and pause requests for active work.
   * Rejects storage/schema failures; returned run ids still require the dispatcher to reach quiescence.
   */
  requestSchedulerDisable(): Promise<SchedulerDisableResult> {
    return this.pauseControl().requestSchedulerDisable()
  }

  /** Persist service-withdrawal pause requests for active runs; it does not itself cancel agents or accept cancellation. */
  requestServiceWithdrawalPause(): Promise<RunId[]> {
    return this.pauseControl().requestServiceWithdrawalPause()
  }

  /** Request an operator pause for one active run; rejects missing/terminal runs and performs no agent cancellation itself. */
  requestRunPause(runId: RunId): Promise<PausingRun | PausedActiveRun> {
    return this.pauseControl().requestRunPause(runId)
  }

  /**
   * Commit a quiescent active-run pause after the dispatcher has observed Git and usage.
   * Rejects stale/non-pausing runs, invalid facts, or durable-write failures; no caller cancellation is accepted.
   */
  checkpointPaused(runId: RunId, git: GitExecutionSnapshot, usage: RunUsageSettlement): Promise<PausedActiveRun> {
    return this.pauseControl().checkpointPaused(runId, git, usage)
  }

  /** Persist an operator hold for queued work before resources are allocated; rejects non-queued runs. */
  holdQueued(runId: RunId): Promise<PausedQueuedRun> {
    return this.pauseControl().holdQueued(runId)
  }

  /** Revalidate and return operator-held queued work to dispatch order; rejects changed eligibility or disabled admission. */
  resumeRun(runId: RunId): Promise<QueuedRun> {
    return this.resumeControl().resumeRun(runId)
  }

  /**
   * Revalidate retained issue, Session/worktree Git facts, scheduler and budget before active continuation.
   * Rejects unauthorized/stale recovery and durable failures; it allocates no external resource and has no cancellation.
   */
  resumeActiveRun(
    runId: RunId,
    observedGit: GitExecutionSnapshot,
    authorization: ActiveResumeAuthorization,
  ): Promise<ImplementingRun> {
    return this.resumeControl().resumeActiveRun(runId, observedGit, authorization)
  }

  /** Persist a bounded explicit-recovery requirement for an allocated paused run; rejects incompatible lifecycle state. */
  requireActiveRecovery(runId: RunId, reason: ActiveRecoveryReason): Promise<PausedActiveRun> {
    return this.resumeControl().requireActiveRecovery(runId, reason)
  }

  /** Atomically claim and reserve the next eligible queued run, or return undefined; rejects invalid settings/state. */
  claimNext(): Promise<ImplementingRun | undefined> {
    return this.executionControl().claimNext()
  }

  /** Persist verified worktree ownership facts for the claimed run; rejects stale identity, invalid Git facts or writes. */
  recordWorktree(runId: RunId, git: GitExecutionSnapshot): Promise<ImplementingRun | PausingRun> {
    return this.executionControl().recordWorktree(runId, git)
  }

  /** Atomically settle one implementing run and its usage reservation; rejects mismatched outcomes or stale state. */
  settle(runId: RunId, outcome: ExecutionOutcome, usage: RunUsageSettlement): Promise<TerminalRun> {
    return this.executionControl().settle(runId, outcome, usage)
  }

  /**
   * Read the selected tracker provider and atomically admit every currently eligible issue.
   * When the scheduler is not enabled, returns an unchanged detached snapshot without reading the provider or retaining
   * an ingress receipt. Provider, validation, capacity, or durable-write failures reject without advancing admission
   * state. Provider withdrawal cancels its owned reads; a caller signal fences mutation after cancellation.
   */
  async reconcile(request: ReconcileRequest): Promise<ReconcileResult> {
    return reconcileAdmission(this.dependencies(), request)
  }

  /** Authenticate raw tracker ingress and keep that provider generation alive through its durable admission commit. */
  async reconcileIngress(request: TrackerIngressRequest, signal?: AbortSignal): Promise<ReconcileResult> {
    return reconcileTrackerIngress(this.dependencies(), request, signal)
  }

  private pauseControl(): PauseControl {
    return new PauseControl(this.dependencies())
  }

  private resumeControl(): ResumeControl {
    return new ResumeControl(this.dependencies())
  }

  private executionControl(): ExecutionControl {
    return new ExecutionControl(this.dependencies())
  }

  private dependencies(): AdmissionDependencies {
    return {
      tracker: this.ctx.tracker,
      settings: () => this.currentSettings(),
      state: () => this.currentState(),
      table: () => this.currentTable(),
    }
  }

  private currentSettings(): AutopilotSettings {
    return this.ctx.autopilotConfig.get()
  }

  private currentTable(): KvTable<typeof STATE_KEY, AdmissionState> {
    if (this.state === undefined) throw new Error('admission service is not initialized')
    return this.state
  }

  private currentState(): AdmissionState {
    const current = this.currentTable().get(STATE_KEY)
    if (current === undefined) throw new Error('admission state record is missing')
    return current
  }

  private async markInterruptedRunsForRecovery(): Promise<void> {
    await this.currentTable().update(STATE_KEY, (current) => {
      if (
        !current.runs.some(
          (run) => (run.state === 'implementing' || run.state === 'pausing') && run.execution.recovery === undefined,
        )
      ) {
        return current
      }
      const interruptedAt = new Date().toISOString()
      const next = structuredClone(current)
      next.runs = next.runs.map((run) =>
        (run.state === 'implementing' || run.state === 'pausing') && run.execution.recovery === undefined
          ? {
              ...run,
              execution: {
                ...run.execution,
                recovery: { kind: 'required', reason: 'host-restart', interruptedAt },
              },
            }
          : run,
      )
      next.revision += 1
      return stateSchema.parse(next)
    })
  }
}

export default Admission
