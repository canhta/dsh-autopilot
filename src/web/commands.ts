import type { Context } from '@deepseek-ai/cordis'
import type { OperatorCommandRecord, RunId } from '../admission.js'
import { publicTrackerFailureMessage, TrackerProviderError } from '../tracker.js'
import { type CommandReceipt, type CommandRequest, commandRequestSchema } from './contract.js'

/** Durable Host command executor; accepted work is recovered after browser disconnect or Host restart. */
export class AutopilotCommands {
  private readonly tasks = new Map<string, { readonly controller: AbortController; readonly done: Promise<void> }>()
  private accepting = false

  constructor(private readonly ctx: Context) {}

  start(): void {
    this.accepting = true
    for (const command of this.ctx.admission.operatorCommands()) {
      if (command.status === 'accepted' || command.status === 'in-progress') this.schedule(command)
    }
  }

  async command(input: CommandRequest): Promise<CommandReceipt> {
    if (!this.accepting) throw new Error('operator commands are unavailable while the Web service is changing')
    const request = commandRequestSchema.parse(input)
    if (this.ctx.admission.operatorCommand(request.requestId) === undefined) this.assertPrecondition(request)
    const accepted = await this.ctx.admission.acceptOperatorCommand(request)
    if (accepted.command.status === 'accepted' || accepted.command.status === 'in-progress') {
      this.schedule(accepted.command)
    }
    return receiptOf(accepted.command)
  }

  status(requestId: string): CommandReceipt | null {
    const command = this.ctx.admission.operatorCommand(requestId)
    return command === undefined ? null : receiptOf(command)
  }

  receipts(): CommandReceipt[] {
    return this.ctx.admission.operatorCommands().map(receiptOf)
  }

  async dispose(): Promise<void> {
    this.accepting = false
    for (const { controller } of this.tasks.values()) controller.abort(new Error('Autopilot Web service withdrawn'))
    await Promise.allSettled([...this.tasks.values()].map(({ done }) => done))
  }

  private schedule(command: OperatorCommandRecord): void {
    if (!this.accepting || this.tasks.has(command.requestId)) return
    const controller = new AbortController()
    const done = this.run(command, controller.signal).finally(() => this.tasks.delete(command.requestId))
    this.tasks.set(command.requestId, { controller, done })
  }

  private async run(command: OperatorCommandRecord, signal: AbortSignal): Promise<void> {
    try {
      await this.ctx.admission.updateOperatorCommand(command.requestId, { status: 'in-progress' })
      signal.throwIfAborted()
      await this.execute(command, signal)
      signal.throwIfAborted()
      await this.ctx.admission.updateOperatorCommand(command.requestId, {
        status: 'succeeded',
        finishedAt: new Date().toISOString(),
      })
    } catch (error) {
      if (signal.aborted) {
        await this.ctx.admission.updateOperatorCommand(command.requestId, { status: 'accepted' })
        return
      }
      await this.ctx.admission.updateOperatorCommand(command.requestId, {
        status: 'rejected',
        finishedAt: new Date().toISOString(),
        message: publicFailure(command.kind, error),
      })
    }
  }

  private async execute(request: OperatorCommandRecord, signal: AbortSignal): Promise<void> {
    if (request.kind === 'pause-scheduler') {
      const dispatch = this.ctx.get('dispatch')
      if (dispatch !== undefined) await dispatch.disableScheduler()
      else await this.ctx.admission.requestSchedulerDisable()
      return
    }
    if (request.kind === 'resume-scheduler') {
      await this.ctx.admission.setSchedulerMode('enabled')
      return
    }
    if (request.kind === 'drain') {
      await this.ctx.admission.setSchedulerMode('draining')
      return
    }
    if (request.kind === 'reconcile') {
      await this.ctx.admission.reconcile({ source: 'manual', signal })
      return
    }
    if (request.kind === 'retry-delivery') {
      const delivery = this.ctx.get('delivery')
      if (delivery === undefined) throw new Error('Delivery service is unavailable.')
      const deliveryId = requiredTarget(request.deliveryId, 'delivery')
      const current = this.ctx.admission
        .snapshot()
        .runs.flatMap((run) => run.deliveries)
        .find((candidate) => candidate.id === deliveryId)
      if (current?.status === 'succeeded' && current.receiptId !== undefined && current.receivedAt !== undefined) return
      await delivery.retry(deliveryId)
      return
    }
    if (request.kind === 'remove-worktree') {
      const operations = this.ctx.get('autopilotOperations')
      if (operations === undefined) throw new Error('Worktree maintenance service is unavailable.')
      if ((await operations.cleanupCommandOutcome(request.requestId)) === 'completed') return
      await operations.removeWorktree(requiredTarget(request.previewId, 'cleanup preview'), request.requestId)
      return
    }
    const runId = requiredTarget(request.runId, 'run') as RunId
    if (request.kind === 'cancel-run') {
      await this.ctx.admission.cancelRun(runId, request.requestId)
      return
    }
    const run = this.ctx.admission.snapshot().runs.find((candidate) => candidate.runId === runId)
    if (run === undefined) throw new Error(`run "${runId}" does not exist`)
    if (request.kind === 'pause-run') {
      if (run.state === 'paused') return
      if (run.state === 'queued') await this.ctx.admission.holdQueued(runId)
      else {
        const dispatch = this.ctx.get('dispatch')
        if (dispatch === undefined) throw new Error('Execution service is unavailable to checkpoint this run.')
        await dispatch.stopRun(runId)
      }
      return
    }
    if (run.state !== 'paused') {
      if (
        run.state === 'queued' ||
        run.state === 'publishing' ||
        run.state === 'completed' ||
        run.state === 'blocked' ||
        run.state === 'failed'
      ) {
        return
      }
      if (run.state === 'cancelled') throw new Error(`run "${runId}" was cancelled before it could resume`)
      if (run.execution.recovery !== undefined) {
        throw new Error(
          `run "${runId}" was interrupted while resuming and requires explicit ${run.execution.recovery.reason} recovery`,
        )
      }
      throw new Error(`run "${runId}" is still ${run.state}; wait for its current execution owner`)
    }
    if (run.pause.kind === 'queued') await this.ctx.admission.resumeRun(runId)
    else {
      const dispatch = this.ctx.get('dispatch')
      if (dispatch === undefined) throw new Error('Execution service is unavailable to resume this run.')
      await dispatch.resumeRun(runId, signal)
    }
  }

  private assertPrecondition(request: CommandRequest): void {
    const runCommand = request.kind === 'pause-run' || request.kind === 'resume-run' || request.kind === 'cancel-run'
    if (runCommand && request.runId === undefined) throw new TypeError(`${request.kind} requires a run id`)
    if (!runCommand && request.runId !== undefined) throw new TypeError(`${request.kind} does not accept a run id`)
    if ((request.kind === 'retry-delivery') !== (request.deliveryId !== undefined)) {
      throw new TypeError(
        request.kind === 'retry-delivery'
          ? 'retry-delivery requires a delivery id'
          : `${request.kind} does not accept a delivery id`,
      )
    }
    if ((request.kind === 'remove-worktree') !== (request.previewId !== undefined)) {
      throw new TypeError(
        request.kind === 'remove-worktree'
          ? 'remove-worktree requires a cleanup preview id'
          : `${request.kind} does not accept a cleanup preview id`,
      )
    }
    if (!runCommand) return
    const run = this.ctx.admission.snapshot().runs.find(({ runId }) => runId === request.runId)
    if (run === undefined) throw new Error(`run "${request.runId}" does not exist`)
    if (
      request.kind === 'pause-run' &&
      run.state !== 'queued' &&
      run.state !== 'implementing' &&
      run.state !== 'pausing'
    )
      throw new Error(`run "${request.runId}" cannot be paused from ${run.state}`)
    if (request.kind === 'resume-run' && run.state !== 'paused')
      throw new Error(`run "${request.runId}" cannot be resumed from ${run.state}`)
    if (request.kind === 'cancel-run' && run.state !== 'queued' && run.state !== 'paused' && run.state !== 'blocked') {
      throw new Error(`run "${request.runId}" cannot be cancelled from ${run.state}`)
    }
  }
}

function requiredTarget(value: string | undefined, name: string): string {
  if (value === undefined) throw new TypeError(`${name} id is required`)
  return value
}

function receiptOf(command: OperatorCommandRecord): CommandReceipt {
  return {
    requestId: command.requestId,
    kind: command.kind,
    status: command.status,
    acceptedAt: command.acceptedAt,
    ...(command.finishedAt === undefined ? {} : { finishedAt: command.finishedAt }),
    ...(command.message === undefined ? {} : { message: command.message }),
    ...(command.revision === undefined ? {} : { revision: command.revision }),
  }
}

function publicFailure(kind: OperatorCommandRecord['kind'], error: unknown): string {
  if (error instanceof TrackerProviderError) return `${error.code}: ${publicTrackerFailureMessage(error.code)}`
  switch (kind) {
    case 'reconcile':
      return 'Tracker reconciliation failed. Check the provider connection and try again.'
    case 'retry-delivery':
      return 'Delivery retry failed. Review the delivery state before trying again.'
    case 'remove-worktree':
      return 'Cleanup was rejected. Request a fresh cleanup preview before trying again.'
    case 'pause-run':
    case 'resume-run':
    case 'cancel-run':
      return 'The run changed before the command completed. Refresh its current state.'
    case 'pause-scheduler':
    case 'resume-scheduler':
    case 'drain':
      return 'The scheduler command failed. Refresh its current state before trying again.'
  }
}
