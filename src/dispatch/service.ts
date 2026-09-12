import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type {
  ActiveResumeAuthorization,
  AdmissionSnapshot,
  ImplementingRun,
  PausedActiveRun,
  RunId,
} from '../admission.js'
import { prepareAgentComposition } from './composition.js'
import type { DispatchResult } from './contract.js'
import { executeClaimed, executeOwnedTurn } from './execute.js'
import { type ActiveExecution, activeExecution, currentRun, isPausedActive } from './execution-state.js'
import { continuationPrompt } from './report.js'
import { type PreparedResume, preparePausedResume } from './resume.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dispatch: Dispatch
  }
}

/** Durable dispatcher composed from the Host's configured DSH Agent, preset, model, Session, and workspace services. */
export class Dispatch extends Service {
  static readonly inject = [
    'admission',
    'agents',
    'agentDefaultModel',
    'agentPresets',
    'permissionPresets',
    'sessions',
    'sessionPersistence',
    'workspaceRegistry',
    'tools',
    'llm',
    'subprocess',
    'autopilotWorkflow',
    'runtimeOwner',
    'autopilotOperations',
  ]

  private readonly active = new Map<RunId, ActiveExecution>()
  private readonly starts = new Set<Promise<void>>()
  private accepting = false

  constructor(ctx: Context) {
    super(ctx, 'dispatch')
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    const releaseOwnerHold = this.ctx.runtimeOwner.hold()
    this.accepting = true
    yield async () => {
      try {
        this.accepting = false
        await Promise.all([...this.starts])
        const owned = [...this.active.values()]
        const pausingRunIds = await this.ctx.admission.requestServiceWithdrawalPause()
        const settled = await Promise.allSettled([
          ...pausingRunIds.map((runId) => this.pauseOwnedExecution(runId, 'required execution service withdrawn')),
          ...owned.map((execution) => execution.completion),
        ])
        const failures = settled.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
        if (failures.length > 0) throw new AggregateError(failures, 'dispatcher withdrawal did not quiesce cleanly')
      } finally {
        releaseOwnerHold()
      }
    }
  }

  /**
   * Claim and execute the next queued run through the Host's configured DSH preset and model, or return undefined when
   * the queue is empty. Requires the injected DSH execution services, valid execution Settings, and Git.
   * The method reserves durable budget before Git/model effects, owns the root Agent to quiescence, flushes its Session,
   * records final Git facts, and settles a structured terminal outcome. Setup/model/Git failures become a failed run
   * when the aggregate remains writable; an aggregate write failure rejects for explicit recovery. The operation
   * accepts no caller cancellation signal.
   */
  async dispatchNext(): Promise<DispatchResult | undefined> {
    this.assertAccepting()
    return await this.ctx.autopilotWorkflow.guardDispatch(() => this.prepareNext())
  }

  private async prepareNext(): Promise<(() => Promise<DispatchResult>) | undefined> {
    this.assertAccepting()
    if (!this.hasRunningCapacity()) return undefined
    const snapshot = this.ctx.admission.snapshot()
    if (snapshot.scheduler.mode === 'enabled') {
      const continuation = snapshot.runs.find(
        (run): run is PausedActiveRun =>
          isPausedActive(run) && !run.pause.operatorHold && run.execution.recovery === undefined,
      )
      if (continuation !== undefined) return await this.prepareResume(continuation.runId, 'scheduler')
    }
    const finishStart = this.beginStart()
    let claimed: ImplementingRun | undefined
    let active: ActiveExecution | undefined
    try {
      await this.assertExecutionStartReady()
      claimed = await this.ctx.admission.claimNext(await prepareAgentComposition(this.ctx))
      if (claimed === undefined) {
        finishStart()
        return undefined
      }
      active = activeExecution()
      this.active.set(claimed.runId, active)
    } catch (error) {
      finishStart()
      throw error
    }
    return async () => {
      try {
        return await executeClaimed(this.ctx, claimed, active, finishStart)
      } finally {
        finishStart()
        this.active.delete(claimed.runId)
        active.complete()
      }
    }
  }

  /**
   * Atomically disable scheduler admission/dequeue, request native cancellation for every live root, and resolve only
   * after each owned execution has reached a durable pause checkpoint. Cancellation-resistant work remains `pausing`
   * and keeps its reservation while this operation waits. Recovered runs without a live owner remain explicit recovery.
   */
  async disableScheduler(): Promise<AdmissionSnapshot> {
    this.assertAccepting()
    const requested = await this.ctx.admission.requestSchedulerDisable()
    await Promise.all(requested.pausingRunIds.map((runId) => this.pauseOwnedExecution(runId, 'scheduler disabled')))
    return this.ctx.admission.snapshot()
  }

  /**
   * Request an operator hold for one live allocated run, cancel its native root, and resolve only after its Session and
   * Autopilot checkpoint are durable. Queued work must use `Admission.holdQueued`; absent live ownership rejects.
   */
  async stopRun(runId: RunId): Promise<PausedActiveRun> {
    this.assertAccepting()
    const active = this.active.get(runId)
    if (active === undefined) throw new Error(`run "${runId}" has no live execution owner`)
    const requested = await this.ctx.admission.requestRunPause(runId)
    if (requested.state === 'paused') return requested
    await this.pauseOwnedExecution(runId, 'operator requested a checkpoint stop')
    const paused = this.ctx.admission.snapshot().runs.find((run) => run.runId === runId)
    if (!isPausedActive(paused)) throw new Error(`run "${runId}" did not reach a durable pause checkpoint`)
    return paused
  }

  /**
   * Resume one allocated pause through DSH's persisted Session path after proving the retained Session and Git worktree
   * are still usable. The same run, Session, worktree, and branch are retained; no fallback identity is created. Tracker,
   * scheduler, routing, Git, and budget gates are revalidated before the resumed Agent receives continuation input.
   * Definite retained-resource failures persist an explicit recovery requirement; other preflight failures preserve the
   * pause. The operation owns the resumed root through disposal. Caller cancellation becomes a durable operator pause
   * before the resumed root is cancelled and drained.
   */
  async resumeRun(runId: RunId, signal?: AbortSignal): Promise<DispatchResult> {
    this.assertAccepting()
    signal?.throwIfAborted()
    const resumed = await this.ctx.autopilotWorkflow.guardDispatch(() => this.prepareResume(runId, 'operator', signal))
    if (resumed === undefined) throw new Error(`run "${runId}" could not be prepared for execution`)
    return resumed
  }

  private async prepareResume(
    runId: RunId,
    authorization: ActiveResumeAuthorization,
    signal?: AbortSignal,
  ): Promise<() => Promise<DispatchResult>> {
    if (!this.hasRunningCapacity()) throw new Error('maximum concurrent runs are already active')
    const finishStart = this.beginStart()
    let prepared: PreparedResume
    try {
      await this.assertExecutionStartReady()
      prepared = await preparePausedResume(this.ctx, this.active, runId, authorization)
    } finally {
      finishStart()
    }
    return () => this.executePreparedResume(prepared, signal)
  }

  private async executePreparedResume(prepared: PreparedResume, signal?: AbortSignal): Promise<DispatchResult> {
    const { run, active, handle, usage, report, baseHead, workspace } = prepared
    let cancellation: Promise<void> | undefined
    const requestCancellation = (): void => {
      if (cancellation !== undefined) return
      active.pauseRequested = true
      handle.agent.cancel(
        { kind: 'hook', reason: 'operator command owner withdrew while resuming this run' },
        { keepInbox: true },
      )
      cancellation = this.ctx.admission.requestRunPause(run.runId).then(() => undefined)
    }
    signal?.addEventListener('abort', requestCancellation)
    if (signal?.aborted === true) requestCancellation()
    try {
      return await executeOwnedTurn(
        this.ctx,
        run,
        active,
        handle,
        usage,
        report,
        baseHead,
        continuationPrompt(run),
        'pause requested before continuation',
        'Agent continuation failed.',
        workspace,
        () => cancellation ?? Promise.resolve(),
      )
    } finally {
      signal?.removeEventListener('abort', requestCancellation)
      await cancellation
      this.active.delete(run.runId)
      active.complete()
    }
  }

  private async pauseOwnedExecution(runId: RunId, reason: string): Promise<void> {
    const active = this.active.get(runId)
    if (active === undefined) {
      const run = currentRun(this.ctx.admission.snapshot(), runId)
      if (run.state === 'pausing' && run.execution.recovery === undefined) {
        throw new Error(`run "${runId}" is pausing without a live execution owner`)
      }
      return
    }
    active.pauseRequested = true
    active.handle?.agent.cancel({ kind: 'hook', reason }, { keepInbox: true })
    await active.completion
    const run = currentRun(this.ctx.admission.snapshot(), runId)
    if (run.state === 'pausing' && run.execution.recovery === undefined) {
      throw new Error(`run "${runId}" quiesced without a durable pause checkpoint`)
    }
  }

  private assertAccepting(): void {
    if (!this.accepting) throw new Error('dispatcher is unavailable while its required services are changing')
  }

  private hasRunningCapacity(): boolean {
    return this.active.size < this.ctx.autopilotConfig.get().maxRunning
  }

  private async assertExecutionStartReady(): Promise<void> {
    await this.ctx.runtimeOwner.ensureOwned()
    await this.ctx.autopilotOperations.assertDispatchReady()
  }

  private beginStart(): () => void {
    this.assertAccepting()
    let resolve: (() => void) | undefined
    const barrier = new Promise<void>((settled) => {
      resolve = settled
    })
    this.starts.add(barrier)
    let finished = false
    return () => {
      if (finished) return
      finished = true
      this.starts.delete(barrier)
      resolve?.()
    }
  }
}

export default Dispatch
