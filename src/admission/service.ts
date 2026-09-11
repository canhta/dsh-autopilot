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

  setSchedulerMode(mode: SchedulerMode): Promise<AdmissionSnapshot> {
    return this.pauseControl().setSchedulerMode(mode)
  }

  requestSchedulerDisable(): Promise<SchedulerDisableResult> {
    return this.pauseControl().requestSchedulerDisable()
  }

  requestServiceWithdrawalPause(): Promise<RunId[]> {
    return this.pauseControl().requestServiceWithdrawalPause()
  }

  requestRunPause(runId: RunId): Promise<PausingRun | PausedActiveRun> {
    return this.pauseControl().requestRunPause(runId)
  }

  checkpointPaused(runId: RunId, git: GitExecutionSnapshot, usage: RunUsageSettlement): Promise<PausedActiveRun> {
    return this.pauseControl().checkpointPaused(runId, git, usage)
  }

  holdQueued(runId: RunId): Promise<PausedQueuedRun> {
    return this.pauseControl().holdQueued(runId)
  }

  resumeRun(runId: RunId): Promise<QueuedRun> {
    return this.resumeControl().resumeRun(runId)
  }

  resumeActiveRun(
    runId: RunId,
    observedGit: GitExecutionSnapshot,
    authorization: ActiveResumeAuthorization,
  ): Promise<ImplementingRun> {
    return this.resumeControl().resumeActiveRun(runId, observedGit, authorization)
  }

  requireActiveRecovery(runId: RunId, reason: ActiveRecoveryReason): Promise<PausedActiveRun> {
    return this.resumeControl().requireActiveRecovery(runId, reason)
  }

  claimNext(): Promise<ImplementingRun | undefined> {
    return this.executionControl().claimNext()
  }

  recordWorktree(runId: RunId, git: GitExecutionSnapshot): Promise<ImplementingRun | PausingRun> {
    return this.executionControl().recordWorktree(runId, git)
  }

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
