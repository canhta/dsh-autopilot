import { type Context, Service } from '@deepseek-ai/cordis'
import type { AdmissionSource, AutopilotRun, ReconcileResult, TerminalRun } from '../admission.js'
import type { PullRequestDisposition, RecoveryParticipantFact } from '../operations.js'
import { preparePublicationReconciliation } from '../publication/git.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    autopilotWorkflow: Workflow
  }
}

type PreparedExecution<T> = () => Promise<T>

/** Production owner that serializes recovery and execution starts without serializing the executions themselves. */
export class Workflow extends Service {
  static readonly inject = [
    'admission',
    'autopilotConfig',
    'publication',
    'delivery',
    'autopilotOperations',
    'pullRequestDisposition',
    'codeHost',
    'subprocess',
  ]

  private readonly controller = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private tail: Promise<void> = Promise.resolve()
  private reconciliation: Promise<ReconcileResult> | undefined
  private accepting = false

  constructor(ctx: Context) {
    super(ctx, 'autopilotWorkflow')
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    const disposeRecovery = this.ctx.autopilotOperations.registerRecoveryParticipant('publication-delivery', {
      reconcile: (signal) => this.reconcileExternalIntents(signal),
    })
    const dispositionDisposers = new Map<string, () => Promise<void>>()
    let dispositionQueue = Promise.resolve()
    let dispositionStopped = false
    const reconcileDispositionRegistrations = async (): Promise<void> => {
      if (dispositionStopped) return
      const providerIds = new Set<string>()
      const configured = this.ctx.autopilotConfig.get().codeHostProvider
      if (configured !== '') providerIds.add(configured)
      for (const run of this.ctx.admission.snapshot().runs) {
        if ('execution' in run) providerIds.add(run.execution.codeHost.providerId)
      }
      for (const providerId of providerIds) {
        if (dispositionDisposers.has(providerId)) continue
        dispositionDisposers.set(
          providerId,
          this.ctx.pullRequestDisposition.register(providerId, {
            inspect: (run, signal) => this.inspectPullRequestDisposition(providerId, run, signal),
          }),
        )
      }
      for (const [providerId, dispose] of dispositionDisposers) {
        if (providerIds.has(providerId)) continue
        dispositionDisposers.delete(providerId)
        await dispose()
      }
    }
    const scheduleDispositionReconciliation = (): Promise<void> => {
      const scheduled = dispositionQueue.then(reconcileDispositionRegistrations)
      dispositionQueue = scheduled.catch(() => undefined)
      return scheduled
    }
    const stopSettingsWatch = this.ctx.autopilotConfig.watch(() => scheduleDispositionReconciliation())
    try {
      await scheduleDispositionReconciliation()
    } catch (error) {
      stopSettingsWatch()
      dispositionStopped = true
      await Promise.all([...dispositionDisposers.values()].map((dispose) => dispose()))
      await disposeRecovery()
      throw error
    }
    this.accepting = true
    yield async () => {
      this.accepting = false
      this.controller.abort(new Error('workflow owner was disposed'))
      stopSettingsWatch()
      dispositionStopped = true
      await dispositionQueue
      await Promise.all([disposeRecovery(), ...[...dispositionDisposers.values()].map((dispose) => dispose())])
      dispositionDisposers.clear()
      await Promise.allSettled(this.operations)
    }
  }

  /** Recover durable intents and atomically prepare one execution, then run it outside the lifecycle lock. */
  async guardDispatch<T>(prepare: () => Promise<PreparedExecution<T> | undefined>): Promise<T | undefined> {
    const execution = await this.exclusive(async (signal) => {
      await this.recoverExternalIntents(signal)
      signal.throwIfAborted()
      return await prepare()
    })
    return await execution?.()
  }

  /** Reconcile all unfinished external intents, refresh admission, then asynchronously fill execution capacity. */
  reconcile(
    source: Exclude<AdmissionSource, 'manual' | 'webhook'>,
    callerSignal?: AbortSignal,
  ): Promise<ReconcileResult> {
    if (!this.accepting) return Promise.reject(new Error('workflow is unavailable while services are changing'))
    if (this.reconciliation !== undefined) return this.reconciliation
    const operation = this.reconcileOwned(source, callerSignal).finally(() => {
      if (this.reconciliation === operation) this.reconciliation = undefined
    })
    this.reconciliation = operation
    return operation
  }

  private async reconcileOwned(
    source: Exclude<AdmissionSource, 'manual' | 'webhook'>,
    callerSignal?: AbortSignal,
  ): Promise<ReconcileResult> {
    const result = await this.exclusive(async (signal) => {
      await this.recoverExternalIntents(signal)
      signal.throwIfAborted()
      return await this.ctx.admission.reconcile({ source, signal })
    }, callerSignal)

    this.advanceExecution()
    return result
  }

  private advanceExecution(): void {
    const dispatch = this.ctx.get('dispatch')
    if (
      dispatch === undefined ||
      this.ctx.autopilotConfig.get().executionMode === 'disabled' ||
      this.ctx.admission.snapshot().scheduler.mode !== 'enabled'
    ) {
      return
    }
    for (let lane = 0; lane < this.ctx.autopilotConfig.get().maxRunning; lane += 1) {
      const operation = this.drainExecutionLane(dispatch).catch(() => {
        this.ctx.logger.warn('autopilot execution advancement failed; inspect durable run and recovery status')
      })
      this.operations.add(operation)
      void operation.finally(() => this.operations.delete(operation)).catch(() => undefined)
    }
  }

  private async drainExecutionLane(dispatch: Context['dispatch']): Promise<void> {
    for (;;) {
      if (
        !this.accepting ||
        this.ctx.autopilotConfig.get().executionMode === 'disabled' ||
        this.ctx.admission.snapshot().scheduler.mode !== 'enabled'
      ) {
        return
      }
      const settled = await dispatch.dispatchNext()
      if (settled === undefined) return
      await this.exclusive(async (signal) => {
        if (settled.state === 'publishing') await this.ctx.publication.publish(settled.runId, signal)
        await this.ctx.delivery.deliverPending(signal)
      })
    }
  }

  private async recoverExternalIntents(signal: AbortSignal): Promise<void> {
    const now = Date.now()
    const unfinished = this.ctx.admission
      .snapshot()
      .runs.filter(
        (run): run is TerminalRun =>
          run.state === 'publishing' &&
          run.publication !== undefined &&
          (['pending', 'uncertain'].includes(run.publication.status) ||
            (run.publication.status === 'retryable-failure' &&
              (run.publication.nextRetryAt === undefined || Date.parse(run.publication.nextRetryAt) <= now))),
      )
    for (const run of unfinished) {
      signal.throwIfAborted()
      await this.ctx.publication.publish(run.runId, signal)
    }
    signal.throwIfAborted()
    await this.ctx.delivery.deliverPending(signal)
  }

  private async reconcileExternalIntents(signal: AbortSignal): Promise<RecoveryParticipantFact> {
    await this.recoverExternalIntents(signal)
    signal.throwIfAborted()
    const runs = this.ctx.admission.snapshot().runs
    const publication = runs.filter((run): run is TerminalRun => run.state === 'publishing')
    const deliveries = runs.flatMap((run) =>
      run.deliveries.filter((delivery) =>
        ['pending', 'in-flight', 'uncertain', 'retryable-failure', 'exhausted'].includes(delivery.status),
      ),
    )
    const failedPublication = publication.some((run) =>
      run.publication === undefined ? true : ['failed', 'exhausted'].includes(run.publication.status),
    )
    const exhaustedDelivery = deliveries.some((delivery) => delivery.status === 'exhausted')
    const pending = publication.length + deliveries.length
    return failedPublication || exhaustedDelivery
      ? { pending, failure: 'publication or delivery recovery requires operator attention' }
      : { pending }
  }

  private async inspectPullRequestDisposition(
    providerId: string,
    run: AutopilotRun,
    signal?: AbortSignal,
  ): Promise<PullRequestDisposition> {
    if (
      (run.state !== 'publishing' && run.state !== 'completed') ||
      run.outcome.kind !== 'verified' ||
      run.publication === undefined
    ) {
      return { state: 'unknown', reason: 'run has no verified publication identity' }
    }
    if (run.execution.codeHost.providerId !== providerId || run.publication.providerId !== providerId) {
      return { state: 'unknown', reason: 'run code-host provider does not match its durable publication identity' }
    }
    const publication = await preparePublicationReconciliation(this.ctx.subprocess, run, signal)
    return await this.ctx.codeHost.withProvider(run.publication.providerId, async (provider) => {
      const observed = await provider.reconcile(publication, signal)
      if (observed.pullRequest.kind !== 'matching') {
        return { state: 'unknown', reason: 'pull request does not match the durable publication identity' }
      }
      const receipt = observed.pullRequest.receipt
      switch (receipt.state) {
        case 'open':
          return { state: 'open', head: receipt.remoteHead }
        case 'merged':
          return { state: 'merged', head: receipt.remoteHead }
        case 'closed-unmerged':
          return { state: 'closed-unmerged', head: receipt.remoteHead }
        default:
          receipt.state satisfies never
          return { state: 'unknown', reason: 'pull request returned an unsupported disposition' }
      }
    })
  }

  private exclusive<T>(operation: (signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal): Promise<T> {
    if (!this.accepting) return Promise.reject(new Error('workflow is unavailable while services are changing'))
    const predecessor = this.tail
    const signal =
      callerSignal === undefined ? this.controller.signal : AbortSignal.any([this.controller.signal, callerSignal])
    const active = predecessor.then(async () => {
      signal.throwIfAborted()
      return await operation(signal)
    })
    this.tail = active.then(
      () => undefined,
      () => undefined,
    )
    this.operations.add(active)
    void active.finally(() => this.operations.delete(active)).catch(() => undefined)
    return active
  }
}

export default Workflow
