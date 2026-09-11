import { STATE_KEY } from './constants.js'
import type {
  AdmissionSnapshot,
  GitExecutionSnapshot,
  PausedActiveRun,
  PausedQueuedRun,
  PausingRun,
  RunId,
  RunUsageSettlement,
  SchedulerDisableResult,
  SchedulerMode,
} from './model.js'
import { activePause, isPausedActiveRun, usageUncertaintyReason, validUsageSettlement } from './policy.js'
import type { AdmissionDependencies } from './ports.js'
import { executionSchema, runIdSchema, schedulerModeSchema, snapshotOf, stateSchema } from './state.js'

export class PauseControl {
  constructor(private readonly dependencies: AdmissionDependencies) {}

  /**
   * Atomically persist the scheduler admission/claim gate and return a detached aggregate snapshot. Draining permits
   * implementing runs to settle; disabling rejects while any run is implementing. Invalid input or durable-write
   * failure leaves the previous mode unchanged. The command accepts no caller cancellation signal.
   */
  async setSchedulerMode(mode: SchedulerMode): Promise<AdmissionSnapshot> {
    const parsedMode = schedulerModeSchema.parse(mode)
    const committed = await this.dependencies.table().update(STATE_KEY, (current) => {
      if (parsedMode === 'disabled' && current.runs.some((run) => run.state === 'implementing')) {
        throw new Error('scheduler cannot be disabled while an implementing run exists')
      }
      if (parsedMode === 'enabled' && current.runs.some((run) => run.state === 'pausing')) {
        throw new Error('scheduler cannot be enabled while a run is still pausing')
      }
      if (current.scheduler.mode === parsedMode) return current
      const next = structuredClone(current)
      next.scheduler = { mode: parsedMode, changedAt: new Date().toISOString() }
      next.revision += 1
      return stateSchema.parse(next)
    })
    return snapshotOf(committed)
  }

  /**
   * Atomically disable admission/dequeue and move every implementing run to `pausing`. The returned run ids identify
   * live executions whose owner must request cancellation and checkpoint only after quiescence. Existing pause requests
   * retain their operator-hold intent. Durable-write failure leaves both scheduler and runs unchanged. This operation
   * requests lifecycle work but does not itself own or cancel an Agent.
   */
  async requestSchedulerDisable(): Promise<SchedulerDisableResult> {
    let pausingRunIds: RunId[] = []
    const committed = await this.dependencies.table().update(STATE_KEY, (current) => {
      const requestedAt = new Date().toISOString()
      const next = structuredClone(current)
      next.scheduler = { mode: 'disabled', changedAt: requestedAt }
      next.runs = next.runs.map((run) =>
        run.state === 'implementing'
          ? {
              ...run,
              state: 'pausing' as const,
              pause: activePause('scheduler', requestedAt),
            }
          : run,
      )
      pausingRunIds = next.runs.filter((run): run is PausingRun => run.state === 'pausing').map((run) => run.runId)
      if (current.scheduler.mode === 'disabled' && !current.runs.some((run) => run.state === 'implementing')) {
        return current
      }
      next.revision += 1
      return stateSchema.parse(next)
    })
    return { snapshot: snapshotOf(committed), pausingRunIds: [...pausingRunIds] }
  }

  /**
   * Atomically move implementing runs to `pausing` before the dispatcher loses a required execution service. Scheduler
   * mode and existing operator/scheduler pause intent are retained. The returned ids identify every pausing execution
   * whose retiring dispatcher owner must cancel and checkpoint before its disposer completes.
   */
  async requestServiceWithdrawalPause(): Promise<RunId[]> {
    let pausingRunIds: RunId[] = []
    await this.dependencies.table().update(STATE_KEY, (current) => {
      const requestedAt = new Date().toISOString()
      const next = structuredClone(current)
      next.runs = next.runs.map((run) =>
        run.state === 'implementing'
          ? {
              ...run,
              state: 'pausing' as const,
              pause: activePause('service-withdrawal', requestedAt),
            }
          : run,
      )
      pausingRunIds = next.runs.filter((run): run is PausingRun => run.state === 'pausing').map((run) => run.runId)
      if (!current.runs.some((run) => run.state === 'implementing')) return current
      next.revision += 1
      return stateSchema.parse(next)
    })
    return [...pausingRunIds]
  }

  /**
   * Atomically request an operator pause for one allocated run. An implementing run becomes `pausing`; an existing
   * scheduler pause is upgraded to an operator hold without losing its original checkpoint facts. Queued runs use
   * `holdQueued` instead. The request owns no Agent cancellation and accepts no caller cancellation signal.
   */
  async requestRunPause(runId: RunId): Promise<PausingRun | PausedActiveRun> {
    const parsedRunId = runIdSchema.parse(runId)
    let requested: PausingRun | PausedActiveRun | undefined
    await this.dependencies.table().update(STATE_KEY, (current) => {
      const index = current.runs.findIndex((run) => run.runId === parsedRunId)
      const run = current.runs[index]
      if (run === undefined) throw new Error(`run "${parsedRunId}" does not exist`)
      if (isPausedActiveRun(run) && run.pause.operatorHold) {
        requested = structuredClone(run)
        return current
      }

      const next = structuredClone(current)
      let nextRun: PausingRun | PausedActiveRun
      if (run.state === 'implementing') {
        nextRun = { ...run, state: 'pausing', pause: activePause('operator', new Date().toISOString()) }
      } else if (run.state === 'pausing') {
        nextRun = {
          ...run,
          pause: { ...run.pause, reason: 'operator', operatorHold: true },
        }
      } else if (isPausedActiveRun(run)) {
        nextRun = {
          ...run,
          pause: { ...run.pause, reason: 'operator', operatorHold: true },
        }
      } else {
        throw new Error(`run "${parsedRunId}" is not an allocated active or paused run`)
      }
      requested = nextRun
      next.runs[index] = nextRun
      next.revision += 1
      return stateSchema.parse(next)
    })
    if (requested === undefined) throw new Error(`run "${parsedRunId}" pause was not requested`)
    return structuredClone(requested)
  }

  /**
   * Commit a pause only after the execution owner has proven its root idle, flushed the Session, and inspected Git.
   * Known usage releases the reservation and advances settled usage. Missing, malformed, or excessive usage retains the
   * reservation and marks deployment usage uncertain for later reconciliation. A lost pause race or write failure leaves
   * the `pausing` checkpoint unchanged. The method accepts no caller cancellation signal.
   */
  async checkpointPaused(runId: RunId, git: GitExecutionSnapshot, usage: RunUsageSettlement): Promise<PausedActiveRun> {
    const parsedRunId = runIdSchema.parse(runId)
    const parsedGit = executionSchema.shape.git.unwrap().parse(git)
    let paused: PausedActiveRun | undefined
    await this.dependencies.table().update(STATE_KEY, (current) => {
      const next = structuredClone(current)
      const index = next.runs.findIndex((run) => run.runId === parsedRunId)
      const run = next.runs[index]
      if (run?.state !== 'pausing') throw new Error(`run "${parsedRunId}" is not pausing`)
      const usageKnown = validUsageSettlement(run, usage)
      const pausedAt = new Date().toISOString()
      paused = {
        ...run,
        state: 'paused',
        execution: { ...run.execution, git: parsedGit },
        budget: {
          ...run.budget,
          reservedTokens: usageKnown ? 0 : run.budget.reservedTokens,
          settledTokens: usageKnown ? run.budget.settledTokens + usage.tokens : run.budget.settledTokens,
          usageUncertain: !usageKnown,
          ...(usageKnown ? {} : { usageUncertaintyReason: usageUncertaintyReason(run, usage) }),
        },
        pause: { ...run.pause, pausedAt, lastCompletedPhase: 'agent-quiescent' },
      }
      next.runs[index] = paused
      if (usageKnown) {
        next.budget.reservedTokens -= run.budget.reservedTokens
        next.budget.settledTokens += usage.tokens
      } else {
        next.budget.usageUncertain = true
      }
      next.revision += 1
      return stateSchema.parse(next)
    })
    if (paused === undefined) throw new Error(`run "${parsedRunId}" pause checkpoint was not recorded`)
    return structuredClone(paused)
  }

  /**
   * Atomically place one queued run on a durable operator hold before Session or worktree allocation.
   * The run must exist and still be queued. Invalid input, a different lifecycle state, or durable-write failure leaves
   * the run unchanged. The returned paused run is detached; this operation has no external effects or cancellation point.
   */
  async holdQueued(runId: RunId): Promise<PausedQueuedRun> {
    const parsedRunId = runIdSchema.parse(runId)
    let held: PausedQueuedRun | undefined
    await this.dependencies.table().update(STATE_KEY, (current) => {
      const index = current.runs.findIndex((run) => run.runId === parsedRunId)
      const run = current.runs[index]
      if (run === undefined) throw new Error(`run "${parsedRunId}" does not exist`)
      if (run.state !== 'queued') throw new Error(`run "${parsedRunId}" is not queued`)

      held = {
        ...structuredClone(run),
        state: 'paused',
        queueClass: 'resumption',
        pause: {
          kind: 'queued',
          reason: 'operator',
          operatorHold: true,
          continuationTarget: 'implementing',
          pausedAt: new Date().toISOString(),
        },
      }
      const next = structuredClone(current)
      next.runs[index] = held
      next.revision += 1
      return stateSchema.parse(next)
    })
    if (held === undefined) throw new Error(`run "${parsedRunId}" was not held`)
    return structuredClone(held)
  }
}
