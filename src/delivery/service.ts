import { type Context, Service } from '@deepseek-ai/cordis'
import { SupersededProjectionError } from '../admission/delivery-control.js'
import type { DeliveryRecord } from '../admission.js'
import { NotificationProviderError } from '../notification.js'
import { TrackerProviderError } from '../tracker.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    delivery: Delivery
  }
}

/** Durable tracker/notification outbox worker; each destination advances independently of run completion. */
export class Delivery extends Service {
  static readonly inject = ['admission', 'tracker', 'notifications']
  private readonly active = new Map<string, Promise<DeliveryRecord>>()
  private readonly controller = new AbortController()
  private accepting = false
  private generation = 0

  constructor(ctx: Context) {
    super(ctx, 'delivery')
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    this.accepting = true
    this.generation += 1
    yield async () => {
      this.accepting = false
      this.generation += 1
      this.controller.abort(new Error('delivery owner was disposed'))
      await Promise.allSettled(this.active.values())
    }
  }

  /** Reconcile and attempt every currently due nonterminal destination, preserving failures independently. */
  async deliverPending(callerSignal?: AbortSignal): Promise<readonly DeliveryRecord[]> {
    this.assertAccepting()
    const now = Date.now()
    const pending = this.ctx.admission
      .snapshot()
      .runs.flatMap((run) => run.deliveries)
      .filter(
        (delivery) =>
          ['pending', 'uncertain'].includes(delivery.status) ||
          (delivery.status === 'retryable-failure' &&
            (delivery.nextRetryAt === undefined || Date.parse(delivery.nextRetryAt) <= now)),
      )
    const results = await Promise.allSettled(pending.map((delivery) => this.deliver(delivery.id, callerSignal)))
    const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    if (failures.length > 0) {
      throw new AggregateError(failures, 'one or more durable deliveries could not record their outcome')
    }
    return results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
  }

  /** Reconcile a single durable intent before mutation; duplicate concurrent callers share one owner promise. */
  deliver(deliveryId: string, callerSignal?: AbortSignal): Promise<DeliveryRecord> {
    this.assertAccepting()
    const current = this.active.get(deliveryId)
    if (current !== undefined) return current
    const generation = this.generation
    const signal =
      callerSignal === undefined ? this.controller.signal : AbortSignal.any([this.controller.signal, callerSignal])
    const operation = this.deliverOwned(deliveryId, generation, signal).finally(() => this.active.delete(deliveryId))
    this.active.set(deliveryId, operation)
    return operation
  }

  /** Requeue one failed destination without changing any successful receipt or repeating code execution. */
  async retry(deliveryId: string): Promise<DeliveryRecord> {
    this.assertAccepting()
    await this.ctx.admission.retryDelivery(deliveryId)
    return await this.deliver(deliveryId)
  }

  /** Retire a failed mutable projection under an updated provider mapping, then deliver its atomic replacement. */
  async repairTrackerProjection(deliveryId: string): Promise<DeliveryRecord> {
    this.assertAccepting()
    const replacement = await this.ctx.admission.repairTrackerProjection(deliveryId)
    return await this.deliver(replacement.id)
  }

  private async deliverOwned(deliveryId: string, generation: number, signal: AbortSignal): Promise<DeliveryRecord> {
    let claimed: Awaited<ReturnType<typeof this.ctx.admission.claimDelivery>>
    try {
      claimed = await this.ctx.admission.claimDelivery(deliveryId)
    } catch (error) {
      if (error instanceof SupersededProjectionError) return error.delivery
      throw error
    }
    const { runId, delivery, owner } = claimed
    try {
      this.assertGeneration(generation, signal)
      const receipt =
        delivery.kind === 'notification'
          ? await this.ctx.notifications.withProvider(delivery.providerId, async (sender) => {
              const existing = await sender.reconcile(delivery.destinationId, delivery.payload, signal)
              this.assertGeneration(generation, signal)
              if (existing !== undefined) return existing
              this.ctx.admission.assertDeliveryOwner(runId, delivery.id, owner)
              return await sender.deliver(delivery.destinationId, delivery.payload, signal)
            })
          : await this.ctx.tracker.withWriter(delivery.providerId, async (writer) => {
              const existing = await writer.reconcileDelivery(delivery.payload, signal)
              this.assertGeneration(generation, signal)
              if (existing.kind === 'conflict') throw new DeliveryConflictError(existing.reason)
              if (existing.kind === 'delivered') return existing.receipt
              this.ctx.admission.assertDeliveryOwner(runId, delivery.id, owner)
              return await writer.deliver(delivery.payload, signal)
            })
      this.assertGeneration(generation, signal)
      return await this.ctx.admission.succeedDelivery(runId, delivery.id, owner, receipt)
    } catch (error) {
      const classified =
        signal.aborted || generation !== this.generation ? { status: 'uncertain' as const } : classifyFailure(error)
      try {
        return await this.ctx.admission.failDelivery(
          runId,
          delivery.id,
          owner,
          error,
          classified.status,
          classified.retryAfterMs,
        )
      } catch (commitError) {
        throw new AggregateError([error, commitError], 'delivery failed and its durable outcome could not be recorded')
      }
    }
  }

  private assertAccepting(): void {
    if (!this.accepting) throw new Error('delivery is unavailable while its required services are changing')
  }

  private assertGeneration(generation: number, signal: AbortSignal): void {
    signal.throwIfAborted()
    if (!this.accepting || generation !== this.generation) throw new Error('delivery owner generation was retired')
  }
}

class DeliveryConflictError extends Error {}

function classifyFailure(error: unknown): {
  status: 'uncertain' | 'retryable-failure' | 'permanent-failure'
  retryAfterMs?: number
} {
  if (error instanceof DeliveryConflictError) return { status: 'permanent-failure' }
  if (error instanceof TrackerProviderError || error instanceof NotificationProviderError) {
    if (['ambiguous-acknowledgement', 'timeout'].includes(error.code)) return { status: 'uncertain' }
    if (['rate-limit', 'transient', 'provider-unavailable'].includes(error.code)) {
      return {
        status: 'retryable-failure',
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      }
    }
    return { status: 'permanent-failure' }
  }
  return { status: 'retryable-failure' }
}

export default Delivery
