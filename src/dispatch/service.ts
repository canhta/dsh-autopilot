import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type {
  ActiveResumeAuthorization,
  AdmissionSnapshot,
  ImplementingRun,
  PausedActiveRun,
  RunId,
} from '../admission.js'
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

/** Fixture-only durable dispatcher built from the DSH Agent, Session, Workspace, Tool, LLM, and Subprocess seams. */
export class Dispatch extends Service {
  static readonly inject = [
    'admission',
    'agents',
    'sessions',
    'sessionPersistence',
    'workspaceRegistry',
    'tools',
    'llm',
    'subprocess',
  ]

  private readonly active = new Map<RunId, ActiveExecution>()
  private readonly starts = new Set<Promise<void>>()
  private accepting = false

  constructor(ctx: Context) {
    super(ctx, 'dispatch')
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    this.accepting = true
    yield async () => {
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
    }
  }

  /**
   * Claim and execute the next queued run through the controlled fixture model, or return undefined when the queue is
   * empty. Requires the injected DSH execution services, a registered fixture adapter, valid fixture Settings, and Git.
   * The method reserves durable budget before Git/model effects, owns the root Agent to quiescence, flushes its Session,
   * records final Git facts, and settles a structured terminal outcome. Setup/model/Git failures become a failed run
   * when the aggregate remains writable; an aggregate write failure rejects for explicit recovery. This first-slice
   * operation accepts no caller cancellation signal.
   */
  async dispatchNext(): Promise<DispatchResult | undefined> {
    this.assertAccepting()
    const snapshot = this.ctx.admission.snapshot()
    if (snapshot.scheduler.mode === 'enabled') {
      const continuation = snapshot.runs.find(
        (run): run is PausedActiveRun =>
          isPausedActive(run) && !run.pause.operatorHold && run.execution.recovery === undefined,
      )
      if (continuation !== undefined) return await this.resumePaused(continuation.runId, 'scheduler')
    }
    const finishStart = this.beginStart()
    let claimed: ImplementingRun | undefined
    let active: ActiveExecution | undefined
    try {
      claimed = await this.ctx.admission.claimNext()
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
    try {
      return await executeClaimed(this.ctx, claimed, active, finishStart)
    } finally {
      finishStart()
      this.active.delete(claimed.runId)
      active.complete()
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
   * pause. The operation owns the resumed root through disposal and accepts no caller cancellation signal.
   */
  async resumeRun(runId: RunId): Promise<DispatchResult> {
    this.assertAccepting()
    return await this.resumePaused(runId, 'operator')
  }

  private async resumePaused(runId: RunId, authorization: ActiveResumeAuthorization): Promise<DispatchResult> {
    const finishStart = this.beginStart()
    let prepared: PreparedResume
    try {
      prepared = await preparePausedResume(this.ctx, this.active, runId, authorization)
    } finally {
      finishStart()
    }
    const { run, active, handle, usage, report, baseHead, workspace } = prepared
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
        'Fixture continuation failed.',
        workspace,
      )
    } finally {
      this.active.delete(runId)
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
