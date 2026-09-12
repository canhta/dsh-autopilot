import { STATE_KEY } from './constants.js'
import type { AutopilotRun, CancelledRun, RunId } from './model.js'
import { isPausedActiveRun, isPausedQueuedRun } from './policy.js'
import type { AdmissionDependencies } from './ports.js'
import { operatorCommandSchema, runIdSchema, stateSchema } from './state.js'

export class CancellationControl {
  constructor(private readonly dependencies: AdmissionDependencies) {}

  /**
   * Atomically end one quiescent queued, paused, or blocked run while retaining every durable identity and external
   * intent. Cancellation performs no tracker, Session, Git, publication, or delivery effect and accepts no signal.
   */
  async cancel(runId: RunId, requestId: string): Promise<CancelledRun> {
    const parsedRunId = runIdSchema.parse(runId)
    const parsedRequestId = operatorCommandSchema.shape.requestId.parse(requestId)
    let cancelled: CancelledRun | undefined
    await this.dependencies.table().update(STATE_KEY, (current) => {
      const index = current.runs.findIndex((run) => run.runId === parsedRunId)
      const run = current.runs[index]
      if (run === undefined) throw new Error(`run "${parsedRunId}" does not exist`)
      if (run.state === 'cancelled') {
        if (run.cancellation.requestId !== parsedRequestId) {
          throw new Error(`run "${parsedRunId}" was already cancelled by another request`)
        }
        cancelled = structuredClone(run)
        return current
      }

      const nextRun = cancelRun(run, parsedRequestId)
      cancelled = nextRun

      const next = structuredClone(current)
      next.runs[index] = nextRun
      next.revision += 1
      return stateSchema.parse(next)
    })
    if (cancelled === undefined) throw new Error(`run "${parsedRunId}" was not cancelled`)
    return structuredClone(cancelled)
  }
}

function cancelRun(run: AutopilotRun, requestId: string): CancelledRun {
  const cancellationBase = { requestId, cancelledAt: new Date().toISOString() }
  if (run.state === 'queued') {
    return { ...structuredClone(run), state: 'cancelled', cancellation: { ...cancellationBase, from: 'queued' } }
  }
  if (isPausedQueuedRun(run)) {
    return {
      ...structuredClone(run),
      state: 'cancelled',
      cancellation: { ...cancellationBase, from: 'paused-queued' },
    }
  }
  if (isPausedActiveRun(run)) {
    return {
      ...structuredClone(run),
      state: 'cancelled',
      cancellation: { ...cancellationBase, from: 'paused-active' },
    }
  }
  if (run.state === 'blocked') {
    if (run.outcome.kind !== 'blocked') throw new Error(`run "${run.runId}" has an invalid blocked outcome`)
    return {
      ...structuredClone(run),
      outcome: run.outcome,
      state: 'cancelled',
      cancellation: { ...cancellationBase, from: 'blocked' },
    }
  }
  throw new Error(`run "${run.runId}" cannot be cancelled from ${run.state}`)
}
