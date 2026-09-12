import { type Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { PullRequestReceipt } from '../code-host.js'
import { codeHostProviderId } from '../code-host.js'
import type { AutopilotSettings } from '../config.js'
import type { NotificationReceipt } from '../notification.js'
import type { TrackerIngressRequest, TrackerOutboundReceipt } from '../tracker.js'
import { CancellationControl } from './cancellation-control.js'
import { consumePreparedAgentComposition, type PreparedAgentComposition } from './composition-claim.js'
import { MAX_AUTOMATIC_EXTERNAL_ATTEMPTS, MAX_OPERATOR_COMMANDS, STATE_KEY } from './constants.js'
import { DeliveryControl } from './delivery-control.js'
import { ExecutionControl } from './execution-control.js'
import type {
  ActiveRecoveryReason,
  ActiveResumeAuthorization,
  AdmissionSnapshot,
  CancelledRun,
  DeliveryRecord,
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
import { PublicationControl } from './publication-control.js'
import { reconcile as reconcileAdmission, reconcileIngress as reconcileTrackerIngress } from './reconciler.js'
import { ResumeControl } from './resume-control.js'
import { RunOperationFence } from './run-fence.js'
import {
  type AdmissionState,
  type OperatorCommandKind,
  type OperatorCommandRecord,
  operatorCommandSchema,
  stateSchema,
} from './state.js'
import { admissionDomainSpec, initialState, snapshotOf } from './state-domain.js'
import { migrateAdmissionStateV6 } from './state-migration.js'

export interface OperatorCommandRequest {
  readonly requestId: string
  readonly kind: OperatorCommandKind
  readonly runId?: string | undefined
  readonly deliveryId?: string | undefined
  readonly previewId?: string | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    admission: Admission
  }
}

export class Admission extends Service {
  static readonly inject = ['tracker', 'autopilotConfig', 'storageDomain']

  private state?: KvTable<typeof STATE_KEY, AdmissionState>
  readonly runOperations = new RunOperationFence()

  constructor(ctx: Context) {
    super(ctx, 'admission')
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    const domain = await this.ctx.storageDomain.open(admissionDomainSpec)
    yield () => domain.close()
    const storedTable = domain.table('state')
    const stored = storedTable.get(STATE_KEY)
    if (stored === undefined) {
      await storedTable.put(STATE_KEY, initialState())
    } else if (stored.schemaVersion === 6) {
      const needsCodeHost = stored.runs.some((run) => typeof run === 'object' && run !== null && 'execution' in run)
      const settings = this.currentSettings()
      if (needsCodeHost && settings.codeHostProvider === '') {
        throw new Error('version-6 admission state with allocated runs requires a configured code-host provider')
      }
      const codeHostBinding = needsCodeHost
        ? this.ctx.get('codeHost')?.binding(codeHostProviderId(settings.codeHostProvider))
        : undefined
      await storedTable.put(STATE_KEY, migrateAdmissionStateV6(stored, settings, codeHostBinding))
    }
    this.state = storedTable as KvTable<typeof STATE_KEY, AdmissionState>
    if (stored !== undefined) await this.markInterruptedRunsForRecovery()
  }

  /**
   * Return a detached view with active work first, then queued work in dispatch order, then retained inactive runs.
   * Throws if the service has not finished initialization; it performs no I/O and has no cancellation point.
   */
  snapshot(): AdmissionSnapshot {
    const current = this.currentState()
    return snapshotOf(current)
  }

  /** Atomically retain one accepted operator command before its effect starts, deduplicated by caller request id. */
  async acceptOperatorCommand(
    request: OperatorCommandRequest,
  ): Promise<{ readonly command: OperatorCommandRecord; readonly created: boolean }> {
    const parsed = operatorCommandSchema
      .pick({ requestId: true, kind: true, runId: true, deliveryId: true, previewId: true })
      .parse(request)
    let created = false
    const committed = await this.currentTable().update(STATE_KEY, (current) => {
      const existing = current.operatorCommands.find(({ requestId }) => requestId === parsed.requestId)
      if (existing !== undefined) {
        if (
          existing.kind !== parsed.kind ||
          existing.runId !== parsed.runId ||
          existing.deliveryId !== parsed.deliveryId ||
          existing.previewId !== parsed.previewId
        ) {
          throw new Error(`command request id "${parsed.requestId}" was already used for a different action`)
        }
        return current
      }
      const next = structuredClone(current)
      const removable = next.operatorCommands.findIndex(({ status }) => status === 'succeeded' || status === 'rejected')
      if (next.operatorCommands.length >= MAX_OPERATOR_COMMANDS) {
        if (removable < 0) throw new Error('too many operator commands are still active')
        next.operatorCommands.splice(removable, 1)
      }
      next.operatorCommands.push({
        ...parsed,
        status: 'accepted',
        acceptedAt: new Date().toISOString(),
      })
      next.revision += 1
      created = true
      return stateSchema.parse(next)
    })
    const command = committed.operatorCommands.find(({ requestId }) => requestId === parsed.requestId)
    if (command === undefined) throw new Error('accepted operator command disappeared from durable state')
    return { command: structuredClone(command), created }
  }

  /** Persist a command transition in the same authoritative aggregate as the run/scheduler effect. */
  async updateOperatorCommand(
    requestId: string,
    patch: Pick<OperatorCommandRecord, 'status'> &
      Partial<Pick<OperatorCommandRecord, 'finishedAt' | 'message' | 'revision'>>,
  ): Promise<OperatorCommandRecord> {
    const committed = await this.currentTable().update(STATE_KEY, (current) => {
      const index = current.operatorCommands.findIndex((command) => command.requestId === requestId)
      if (index < 0) throw new Error(`operator command "${requestId}" does not exist`)
      const next = structuredClone(current)
      const prior = next.operatorCommands[index]
      if (prior === undefined) throw new Error(`operator command "${requestId}" disappeared`)
      next.revision += 1
      next.operatorCommands[index] = operatorCommandSchema.parse({
        ...prior,
        ...patch,
        ...(patch.status === 'succeeded' ? { revision: next.revision } : {}),
      })
      return stateSchema.parse(next)
    })
    const command = committed.operatorCommands.find((candidate) => candidate.requestId === requestId)
    if (command === undefined) throw new Error(`operator command "${requestId}" disappeared after update`)
    return structuredClone(command)
  }

  operatorCommand(requestId: string): OperatorCommandRecord | undefined {
    const command = this.currentState().operatorCommands.find((candidate) => candidate.requestId === requestId)
    return command === undefined ? undefined : structuredClone(command)
  }

  operatorCommands(): OperatorCommandRecord[] {
    return structuredClone(this.currentState().operatorCommands)
  }

  /** Explain whether durable runs or outbound intents still depend on one tracker configuration. */
  trackerSwitchBlocker(providerId: string): string | undefined {
    const dependents = this.currentState().runs.filter(
      (run) =>
        (run.providerId === providerId &&
          run.state !== 'failed' &&
          run.state !== 'completed' &&
          run.state !== 'cancelled') ||
        run.deliveries.some(
          (delivery) =>
            delivery.kind !== 'notification' &&
            delivery.providerId === providerId &&
            delivery.status !== 'succeeded' &&
            delivery.status !== 'retired',
        ),
    )
    if (dependents.length === 0) return undefined
    const shown = dependents.slice(0, 3).map(({ displayKey }) => displayKey)
    return `Tracker configuration cannot change while unfinished work or unresolved delivery intents remain for ${String(dependents.length)} affected run${dependents.length === 1 ? '' : 's'} (${shown.join(', ')}${dependents.length > shown.length ? ', …' : ''}).`
  }

  /** Explain whether admitted runs still depend on one code-host provider selection. */
  codeHostSwitchBlocker(providerId: string): string | undefined {
    const dependents = this.currentState().runs.filter(
      (run) =>
        ((run.state === 'queued' || (run.state === 'paused' && run.pause.kind === 'queued')) && providerId !== '') ||
        ('execution' in run &&
          run.execution.codeHost.providerId === providerId &&
          run.state !== 'failed' &&
          run.state !== 'completed' &&
          (run.state !== 'cancelled' ||
            ('publication' in run &&
              run.publication !== undefined &&
              !['failed', 'succeeded'].includes(run.publication.status)))),
    )
    if (dependents.length === 0) return undefined
    const shown = dependents.slice(0, 3).map(({ displayKey }) => displayKey)
    return `Code-host configuration cannot change while ${String(dependents.length)} unfinished run${dependents.length === 1 ? ' depends' : 's depend'} on it (${shown.join(', ')}${dependents.length > shown.length ? ', …' : ''}).`
  }

  /** Prevent one provider id from being rebound while queued work or durable run history still names that binding. */
  codeHostBindingSwitchBlocker(providerId: string): string | undefined {
    const dependents = this.currentState().runs.filter(
      (run) =>
        run.state === 'queued' ||
        (run.state === 'paused' && run.pause.kind === 'queued') ||
        ('execution' in run && run.execution.codeHost.providerId === providerId),
    )
    if (dependents.length === 0) return undefined
    const shown = dependents.slice(0, 3).map(({ displayKey }) => displayKey)
    return `Code-host binding configuration cannot change while durable run history or queued work remains for ${String(dependents.length)} affected run${dependents.length === 1 ? '' : 's'} (${shown.join(', ')}${dependents.length > shown.length ? ', …' : ''}).`
  }

  /** Explain whether unallocated admitted work would be redirected by an execution-routing Settings change. */
  executionRoutingSwitchBlocker(): string | undefined {
    const dependents = this.currentState().runs.filter(
      (run) => run.state === 'queued' || (run.state === 'paused' && run.pause.kind === 'queued'),
    )
    if (dependents.length === 0) return undefined
    const shown = dependents.slice(0, 3).map(({ displayKey }) => displayKey)
    return `Execution routing cannot change while ${String(dependents.length)} admitted run${dependents.length === 1 ? ' is' : 's are'} waiting for allocation (${shown.join(', ')}${dependents.length > shown.length ? ', …' : ''}).`
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
    return this.runOperations.mutateMany(
      this.snapshot().runs.map((run) => run.runId),
      () => this.pauseControl().requestSchedulerDisable(),
    )
  }

  /** Persist service-withdrawal pause requests for active runs; it does not itself cancel agents or accept cancellation. */
  requestServiceWithdrawalPause(): Promise<RunId[]> {
    return this.runOperations.mutateMany(
      this.snapshot().runs.map((run) => run.runId),
      () => this.pauseControl().requestServiceWithdrawalPause(),
    )
  }

  /** Request an operator pause for one active run; rejects missing/terminal runs and performs no agent cancellation itself. */
  requestRunPause(runId: RunId): Promise<PausingRun | PausedActiveRun> {
    return this.runOperations.mutate(runId, () => this.pauseControl().requestRunPause(runId))
  }

  /**
   * Commit a quiescent active-run pause after the dispatcher has observed Git and usage.
   * Rejects stale/non-pausing runs, invalid facts, or durable-write failures; no caller cancellation is accepted.
   */
  checkpointPaused(runId: RunId, git: GitExecutionSnapshot, usage: RunUsageSettlement): Promise<PausedActiveRun> {
    return this.runOperations.mutate(runId, () => this.pauseControl().checkpointPaused(runId, git, usage))
  }

  /** Persist an operator hold for queued work before resources are allocated; rejects non-queued runs. */
  holdQueued(runId: RunId): Promise<PausedQueuedRun> {
    return this.runOperations.mutate(runId, () => this.pauseControl().holdQueued(runId))
  }

  /** End one quiescent queued, paused, or blocked run without authorizing tracker or resource side effects. */
  cancelRun(runId: RunId, requestId: string): Promise<CancelledRun> {
    return this.runOperations.mutate(runId, () => this.cancellationControl().cancel(runId, requestId))
  }

  /** Revalidate and return operator-held queued work to dispatch order; rejects changed eligibility or disabled admission. */
  resumeRun(runId: RunId): Promise<QueuedRun> {
    return this.runOperations.mutate(runId, () => this.resumeControl().resumeRun(runId))
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
    return this.runOperations.mutate(runId, () =>
      this.resumeControl().resumeActiveRun(runId, observedGit, authorization),
    )
  }

  /** Persist a bounded explicit-recovery requirement for an allocated paused run; rejects incompatible lifecycle state. */
  requireActiveRecovery(runId: RunId, reason: ActiveRecoveryReason): Promise<PausedActiveRun> {
    return this.runOperations.mutate(runId, () => this.resumeControl().requireActiveRecovery(runId, reason))
  }

  /** Atomically claim and reserve the next eligible queued run, or return undefined; rejects invalid settings/state. */
  async claimNext(preparedAgent: PreparedAgentComposition): Promise<ImplementingRun | undefined> {
    const agent = consumePreparedAgentComposition(preparedAgent)
    for (;;) {
      const snapshot = this.snapshot()
      if (snapshot.scheduler.mode !== 'enabled') return undefined
      if (snapshot.budget.usageUncertain) return await this.executionControl().claimNext(agent)
      const queued = snapshot.runs.find((run) => run.state === 'queued')
      if (queued === undefined) return undefined
      const claimed = await this.runOperations.mutate(queued.runId, () =>
        this.executionControl().claimNext(agent, queued.runId),
      )
      if (claimed !== undefined) return claimed
    }
  }

  /** Persist verified worktree ownership facts for the claimed run; rejects stale identity, invalid Git facts or writes. */
  recordWorktree(runId: RunId, git: GitExecutionSnapshot): Promise<ImplementingRun | PausingRun> {
    return this.runOperations.mutate(runId, () => this.executionControl().recordWorktree(runId, git))
  }

  /** Atomically settle one implementing run and its usage reservation; rejects mismatched outcomes or stale state. */
  settle(runId: RunId, outcome: ExecutionOutcome, usage: RunUsageSettlement): Promise<TerminalRun> {
    return this.runOperations.mutate(runId, () => this.executionControl().settle(runId, outcome, usage))
  }

  /** Claim one persisted publication intent for the sole Host publisher; no external side effect occurs. */
  claimPublication(runId: RunId): Promise<{ run: TerminalRun; owner: string }> {
    return this.runOperations.mutate(runId, () => this.publicationControl().claim(runId))
  }

  /** Fail if a publication worker no longer owns the current durable intent; this check performs no I/O. */
  assertPublicationOwner(runId: RunId, owner: string): void {
    this.publicationControl().assertOwner(runId, owner)
  }

  /** Persist a reconciled remote branch receipt while retaining publication ownership. */
  recordPublicationBranch(runId: RunId, owner: string, remoteHead: string): Promise<TerminalRun> {
    return this.runOperations.mutate(runId, () => this.publicationControl().recordBranch(runId, owner, remoteHead))
  }

  /** Commit the confirmed ready PR and completed lifecycle event atomically. */
  completePublication(runId: RunId, owner: string, receipt: PullRequestReceipt): Promise<TerminalRun> {
    return this.runOperations.mutate(runId, () => this.publicationControl().complete(runId, owner, receipt))
  }

  /** Persist a sanitized permanent, retryable, or ambiguous publication failure without changing verified work. */
  failPublication(
    runId: RunId,
    owner: string,
    error: unknown,
    status: 'uncertain' | 'retryable-failure' | 'failed',
    retryAfterMs?: number,
  ): Promise<TerminalRun> {
    return this.runOperations.mutate(runId, () =>
      this.publicationControl().fail(runId, owner, error, status, retryAfterMs),
    )
  }

  claimDelivery(deliveryId: string): Promise<{ runId: RunId; delivery: DeliveryRecord; owner: string }> {
    const runId = this.deliveryRunId(deliveryId)
    return this.runOperations.mutate(runId, () => {
      if (this.deliveryRunId(deliveryId) !== runId) throw new Error(`delivery "${deliveryId}" changed runs`)
      return this.deliveryControl().claim(deliveryId)
    })
  }

  assertDeliveryOwner(runId: RunId, deliveryId: string, owner: string): void {
    this.deliveryControl().assertOwner(runId, deliveryId, owner)
  }

  succeedDelivery(
    runId: RunId,
    deliveryId: string,
    owner: string,
    receipt: TrackerOutboundReceipt | NotificationReceipt,
  ): Promise<DeliveryRecord> {
    return this.runOperations.mutate(runId, () => this.deliveryControl().succeed(runId, deliveryId, owner, receipt))
  }

  failDelivery(
    runId: RunId,
    deliveryId: string,
    owner: string,
    error: unknown,
    status: 'uncertain' | 'retryable-failure' | 'permanent-failure',
    retryAfterMs?: number,
  ): Promise<DeliveryRecord> {
    return this.runOperations.mutate(runId, () =>
      this.deliveryControl().fail(runId, deliveryId, owner, error, status, retryAfterMs),
    )
  }

  retryDelivery(deliveryId: string): Promise<DeliveryRecord> {
    const runId = this.deliveryRunId(deliveryId)
    return this.runOperations.mutate(runId, () => {
      if (this.deliveryRunId(deliveryId) !== runId) throw new Error(`delivery "${deliveryId}" changed runs`)
      return this.deliveryControl().retry(deliveryId)
    })
  }

  /** Replace one settled failed tracker projection after its provider mapping has been corrected. */
  repairTrackerProjection(deliveryId: string): Promise<DeliveryRecord> {
    const runId = this.deliveryRunId(deliveryId)
    return this.runOperations.mutate(runId, () => {
      if (this.deliveryRunId(deliveryId) !== runId) throw new Error(`delivery "${deliveryId}" changed runs`)
      return this.deliveryControl().repairProjection(deliveryId)
    })
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

  private cancellationControl(): CancellationControl {
    return new CancellationControl(this.dependencies())
  }

  private resumeControl(): ResumeControl {
    return new ResumeControl(this.dependencies())
  }

  private executionControl(): ExecutionControl {
    return new ExecutionControl(this.dependencies())
  }

  private publicationControl(): PublicationControl {
    return new PublicationControl(this.dependencies())
  }

  private deliveryControl(): DeliveryControl {
    return new DeliveryControl(this.dependencies())
  }

  private deliveryRunId(deliveryId: string): RunId {
    const run = this.currentState().runs.find((candidate) =>
      candidate.deliveries.some((delivery) => delivery.id === deliveryId),
    )
    if (run === undefined) throw new Error(`delivery "${deliveryId}" does not exist`)
    return run.runId
  }

  private dependencies(): AdmissionDependencies {
    const codeHost = this.ctx.get('codeHost')
    return {
      ...(codeHost === undefined ? {} : { codeHost }),
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
          (run) =>
            ((run.state === 'implementing' || run.state === 'pausing') && run.execution.recovery === undefined) ||
            (run.state === 'publishing' && run.publication?.status === 'in-flight') ||
            run.deliveries.some((delivery) => delivery.status === 'in-flight'),
        )
      ) {
        return current
      }
      const interruptedAt = new Date().toISOString()
      const next = structuredClone(current)
      next.runs = next.runs.map((run) => {
        const interruptedExecution =
          (run.state === 'implementing' || run.state === 'pausing') && run.execution.recovery === undefined
            ? {
                ...run,
                execution: {
                  ...run.execution,
                  recovery: { kind: 'required' as const, reason: 'host-restart' as const, interruptedAt },
                },
              }
            : run
        return {
          ...interruptedExecution,
          ...(interruptedExecution.state === 'publishing' && interruptedExecution.publication?.status === 'in-flight'
            ? {
                publication: {
                  ...interruptedExecution.publication,
                  status:
                    interruptedExecution.publication.attempts >= MAX_AUTOMATIC_EXTERNAL_ATTEMPTS
                      ? ('exhausted' as const)
                      : ('uncertain' as const),
                  owner: undefined,
                  exhaustedFrom:
                    interruptedExecution.publication.attempts >= MAX_AUTOMATIC_EXTERNAL_ATTEMPTS
                      ? ('uncertain' as const)
                      : undefined,
                  lastError: 'Host restarted while publication acknowledgement was unresolved.',
                },
              }
            : {}),
          deliveries: interruptedExecution.deliveries.map((delivery) =>
            delivery.status === 'in-flight'
              ? {
                  ...delivery,
                  status:
                    delivery.attempts >= MAX_AUTOMATIC_EXTERNAL_ATTEMPTS
                      ? ('exhausted' as const)
                      : ('uncertain' as const),
                  owner: undefined,
                  exhaustedFrom:
                    delivery.attempts >= MAX_AUTOMATIC_EXTERNAL_ATTEMPTS ? ('uncertain' as const) : undefined,
                  lastError: 'Host restarted while delivery acknowledgement was unresolved.',
                }
              : delivery,
          ),
        }
      })
      next.revision += 1
      return stateSchema.parse(next)
    })
  }
}

export default Admission
