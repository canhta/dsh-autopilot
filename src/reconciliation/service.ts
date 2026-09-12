import { type Context, Service } from '@deepseek-ai/cordis'
import { AdmissionIngressError, type AdmissionSource, type ReconcileResult } from '../admission.js'
import {
  publicTrackerFailureMessage,
  type TrackerIngressRequest,
  TrackerProviderError,
  type TrackerProviderErrorCode,
  trackerProviderId,
} from '../tracker.js'

type TimedReconciliationSource = Exclude<AdmissionSource, 'manual' | 'webhook'>
export type ReconciliationErrorCode = 'overloaded' | 'unavailable'

// Admission serializes durable commits. This permits a useful webhook burst while
// bounding retained 256 KiB ingress bodies to roughly 8 MiB per process.
const MAX_CONCURRENT_INGRESS_ATTEMPTS = 32

const reconciliationErrorMessages: Record<ReconciliationErrorCode, string> = {
  overloaded: 'Autopilot ingress is temporarily at capacity.',
  unavailable: 'Autopilot is not accepting tracker ingress.',
}

/** A caller-safe failure raised by the reconciliation owner itself. */
export class ReconciliationError extends Error {
  constructor(readonly code: ReconciliationErrorCode) {
    super(reconciliationErrorMessages[code])
    this.name = 'ReconciliationError'
  }
}

export interface ReconciliationFailure {
  readonly code: TrackerProviderErrorCode | ReconciliationErrorCode | 'internal'
  readonly message: string
  readonly retryAfterMs?: number
}

export interface ReconciliationAttemptSnapshot {
  readonly source: AdmissionSource
  readonly startedAt: string
  readonly completedAt: string
  readonly outcome: 'succeeded' | 'failed'
  readonly admitted: number
  readonly deferred: number
  readonly rejected: number
  readonly failure?: ReconciliationFailure
}

export interface ReconciliationSnapshot {
  readonly active: number
  readonly nextScheduledAt?: string
  readonly lastAttempt?: ReconciliationAttemptSnapshot
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    autopilotReconciliation: Reconciliation
  }
}

/** Own startup/periodic admission timing and expose bounded operator diagnostics. */
export class Reconciliation extends Service {
  static readonly inject = ['admission', 'autopilotConfig', 'tracker']

  private timer: ReturnType<typeof setTimeout> | undefined
  private lifecycleAttempt: Promise<void> | undefined
  private startupPending = false
  private readonly ingressAttempts = new Set<Promise<ReconcileResult>>()
  private readonly controller = new AbortController()
  private stopping = false
  private active = 0
  private nextScheduledAt: string | undefined
  private lastAttempt: ReconciliationAttemptSnapshot | undefined

  constructor(ctx: Context) {
    super(ctx, 'autopilotReconciliation')
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    const stopSettingsWatch = this.ctx.autopilotConfig.watch(() => {
      this.clearTimer()
      if (this.lifecycleAttempt === undefined) this.scheduleNext()
    })
    const stopProviderWatch = this.ctx.tracker.watchProviders((event) => {
      if (
        event.kind === 'available' &&
        event.providerId === trackerProviderId(this.ctx.autopilotConfig.get().trackerProvider)
      ) {
        if (this.lifecycleAttempt === undefined) void this.runTimed('startup')
        else this.startupPending = true
      }
    })
    yield async () => {
      this.stopping = true
      this.controller.abort(new Error('reconciliation owner was disposed'))
      stopSettingsWatch()
      stopProviderWatch()
      this.clearTimer()
      await Promise.allSettled([
        ...(this.lifecycleAttempt === undefined ? [] : [this.lifecycleAttempt]),
        ...this.ingressAttempts,
      ])
    }
    queueMicrotask(() => {
      void this.runTimed('startup')
    })
  }

  /**
   * Return a detached, bounded view of reconciliation activity and its most recent sanitized outcome.
   *
   * Preconditions: none; a retained module reference remains inspectable during shutdown. This operation has no side
   * effects, performs no I/O, does not fail under normal operation, and is not cancellable.
   */
  snapshot(): ReconciliationSnapshot {
    return {
      active: this.active,
      ...(this.nextScheduledAt === undefined ? {} : { nextScheduledAt: this.nextScheduledAt }),
      ...(this.lastAttempt === undefined ? {} : { lastAttempt: structuredClone(this.lastAttempt) }),
    }
  }

  /**
   * Authenticate and durably reconcile one provider delivery.
   *
   * The request must preserve the HTTP method, raw header multiplicity, and exact body bytes expected by the selected
   * tracker provider. A successful promise means the delivery identity and resulting admission decisions were committed
   * before acknowledgement is safe. The operation updates aggregate diagnostics but never records request or ticket
   * content. It rejects with `ReconciliationError('overloaded')` before launching work when 32 ingress attempts are
   * already active or admission capacity cannot consume the delivery, and with `ReconciliationError('unavailable')` when
   * admission is not accepting deliveries. Provider and durable-write failures are propagated while the diagnostics view
   * exposes only their sanitized classification. `signal` is combined with owner disposal; cancellation is cooperative
   * and fences persistent mutation before commit, but callers must still await the rejected promise before releasing owned
   * resources.
   */
  acceptIngress(request: TrackerIngressRequest, signal?: AbortSignal): Promise<ReconcileResult> {
    if (this.stopping) {
      return Promise.reject(new ReconciliationError('unavailable'))
    }
    if (this.ingressAttempts.size >= MAX_CONCURRENT_INGRESS_ATTEMPTS) {
      const error = new ReconciliationError('overloaded')
      this.lastAttempt = failedAttempt('webhook', new Date().toISOString(), error)
      return Promise.reject(error)
    }
    const attempt = this.runIngress(request, signal)
    this.ingressAttempts.add(attempt)
    return attempt.then(
      (result) => {
        this.ingressAttempts.delete(attempt)
        return result
      },
      (error: unknown) => {
        this.ingressAttempts.delete(attempt)
        throw error
      },
    )
  }

  private async runIngress(request: TrackerIngressRequest, callerSignal?: AbortSignal): Promise<ReconcileResult> {
    const source = 'webhook' as const
    const startedAt = new Date().toISOString()
    const signal =
      callerSignal === undefined ? this.controller.signal : AbortSignal.any([this.controller.signal, callerSignal])
    this.active += 1
    try {
      const result = await this.ctx.admission.reconcileIngress(request, signal)
      this.lastAttempt = successfulAttempt(source, startedAt, result)
      return result
    } catch (error) {
      const failure = translateIngressFailure(error)
      this.lastAttempt = failedAttempt(source, startedAt, failure)
      throw failure
    } finally {
      this.active -= 1
    }
  }

  private runTimed(source: TimedReconciliationSource): Promise<void> {
    if (this.stopping) return Promise.resolve()
    if (this.lifecycleAttempt !== undefined) return this.lifecycleAttempt
    this.clearTimer()
    const startedAt = new Date().toISOString()
    this.active += 1
    const workflow = this.ctx.get('autopilotWorkflow')
    const attempt = (
      workflow === undefined
        ? this.ctx.admission.reconcile({ source, signal: this.controller.signal })
        : workflow.reconcile(source, this.controller.signal)
    )
      .then((result) => {
        this.lastAttempt = successfulAttempt(source, startedAt, result)
      })
      .catch((error: unknown) => {
        this.lastAttempt = failedAttempt(source, startedAt, error)
        const failure = this.lastAttempt.failure
        if (failure === undefined) throw new Error('failed reconciliation lost its diagnostic')
        this.ctx.logger.warn(`autopilot ${source} reconciliation failed: ${failure.code}`)
      })
      .finally(() => {
        this.active -= 1
        if (this.lifecycleAttempt === attempt) this.lifecycleAttempt = undefined
        if (this.stopping) return
        if (this.startupPending) {
          this.startupPending = false
          void this.runTimed('startup')
        } else {
          this.scheduleNext()
        }
      })
    this.lifecycleAttempt = attempt
    return attempt
  }

  private scheduleNext(): void {
    if (this.stopping || this.timer !== undefined) return
    const delay = this.ctx.autopilotConfig.get().reconcileIntervalSeconds * 1000
    this.nextScheduledAt = new Date(Date.now() + delay).toISOString()
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.nextScheduledAt = undefined
      void this.runTimed('scheduled')
    }, delay)
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.nextScheduledAt = undefined
  }
}

function translateIngressFailure(error: unknown): unknown {
  if (!(error instanceof AdmissionIngressError)) return error
  return new ReconciliationError(error.code === 'queue-capacity' ? 'overloaded' : 'unavailable')
}

function successfulAttempt(
  source: AdmissionSource,
  startedAt: string,
  result: ReconcileResult,
): ReconciliationAttemptSnapshot {
  return {
    source,
    startedAt,
    completedAt: new Date().toISOString(),
    outcome: 'succeeded',
    admitted: result.decisions.filter((decision) => decision.outcome === 'queued').length,
    deferred: result.decisions.filter((decision) => decision.outcome === 'deferred').length,
    rejected: result.decisions.filter((decision) => decision.outcome === 'rejected').length,
  }
}

function failedAttempt(source: AdmissionSource, startedAt: string, error: unknown): ReconciliationAttemptSnapshot {
  return {
    source,
    startedAt,
    completedAt: new Date().toISOString(),
    outcome: 'failed',
    admitted: 0,
    deferred: 0,
    rejected: 0,
    failure: sanitizedFailure(error),
  }
}

function sanitizedFailure(error: unknown): ReconciliationFailure {
  if (error instanceof ReconciliationError) {
    return { code: error.code, message: error.message }
  }
  if (error instanceof TrackerProviderError) {
    return {
      code: error.code,
      message: publicTrackerFailureMessage(error.code),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    }
  }
  return { code: 'internal', message: 'Reconciliation failed before it could commit.' }
}

export default Reconciliation
