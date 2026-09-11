import { type Context, Service } from '@deepseek-ai/cordis'
import type { AdmissionSource, ReconcileResult } from '../admission.js'
import {
  type TrackerIngressRequest,
  TrackerProviderError,
  type TrackerProviderErrorCode,
  trackerProviderId,
} from '../tracker.js'

type TimedReconciliationSource = Exclude<AdmissionSource, 'manual' | 'webhook'>

export interface ReconciliationFailure {
  readonly code: TrackerProviderErrorCode | 'internal'
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
    reconciliation: Reconciliation
  }
}

/** Own startup/periodic admission timing and expose bounded operator diagnostics. */
export class Reconciliation extends Service {
  static readonly inject = ['admission', 'autopilotConfig', 'tracker']

  private timer: ReturnType<typeof setTimeout> | undefined
  private lifecycleAttempt: Promise<void> | undefined
  private readonly ingressAttempts = new Set<Promise<ReconcileResult>>()
  private readonly controller = new AbortController()
  private stopping = false
  private active = 0
  private nextScheduledAt: string | undefined
  private lastAttempt: ReconciliationAttemptSnapshot | undefined

  constructor(ctx: Context) {
    super(ctx, 'reconciliation')
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
        void this.runTimed('startup')
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

  snapshot(): ReconciliationSnapshot {
    return {
      active: this.active,
      ...(this.nextScheduledAt === undefined ? {} : { nextScheduledAt: this.nextScheduledAt }),
      ...(this.lastAttempt === undefined ? {} : { lastAttempt: structuredClone(this.lastAttempt) }),
    }
  }

  /** Authenticate and reconcile one delivery, exposing only bounded aggregate counts and sanitized failures. */
  acceptIngress(request: TrackerIngressRequest): Promise<ReconcileResult> {
    if (this.stopping) {
      return Promise.reject(new TrackerProviderError('provider-unavailable', 'reconciliation owner is unavailable'))
    }
    const attempt = this.runIngress(request)
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

  private async runIngress(request: TrackerIngressRequest): Promise<ReconcileResult> {
    const source = 'webhook' as const
    const startedAt = new Date().toISOString()
    this.active += 1
    try {
      const result = await this.ctx.admission.reconcileIngress(request, this.controller.signal)
      this.lastAttempt = successfulAttempt(source, startedAt, result)
      return result
    } catch (error) {
      this.lastAttempt = failedAttempt(source, startedAt, error)
      throw error
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
    const attempt = this.ctx.admission
      .reconcile({ source, signal: this.controller.signal })
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
        this.scheduleNext()
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
  if (error instanceof TrackerProviderError) {
    return {
      code: error.code,
      message: providerFailureMessage(error.code),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    }
  }
  return { code: 'internal', message: 'Reconciliation failed before it could commit.' }
}

function providerFailureMessage(code: TrackerProviderErrorCode): string {
  switch (code) {
    case 'authentication':
      return 'Tracker authentication failed.'
    case 'permission':
      return 'Tracker access was denied.'
    case 'invalid-configuration':
      return 'Tracker configuration is invalid or incomplete.'
    case 'not-found':
      return 'A configured tracker resource was not found.'
    case 'conflict':
      return 'Tracker state could not be reconciled safely.'
    case 'rate-limit':
      return 'Tracker rate limiting deferred reconciliation.'
    case 'timeout':
      return 'The tracker request timed out.'
    case 'transient':
      return 'The tracker was temporarily unavailable.'
    case 'unsupported-capability':
      return 'The selected tracker does not support this operation.'
    case 'ambiguous-acknowledgement':
      return 'Tracker acknowledgement could not be confirmed.'
    case 'invalid-response':
      return 'The tracker returned an invalid or unsafe response.'
    case 'provider-unavailable':
      return 'The selected tracker provider is unavailable.'
  }
}

export default Reconciliation
