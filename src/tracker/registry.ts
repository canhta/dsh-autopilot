import { type Context, Service } from '@deepseek-ai/cordis'
import {
  TRACKER_INTERFACE_VERSION,
  type TrackerCandidatePage,
  type TrackerIngressDelivery,
  type TrackerIngressRequest,
  type TrackerProvider,
  TrackerProviderError,
  type TrackerProviderId,
  type TrackerProviderLifecycleEvent,
  type TrackerReader,
  type TrackerReadRequest,
  trackerCapabilities,
} from './model.js'
import { candidatePageSchema, ingressDeliverySchema } from './validation.js'

interface RegisteredProvider {
  provider: TrackerProvider
  controller: AbortController
  active: Set<Promise<unknown>>
  accepting: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tracker: Tracker
  }
}

/** Provider registry and normalized read seam consumed by admission. */
export class Tracker extends Service {
  private readonly providers = new Map<TrackerProviderId, RegisteredProvider>()
  private readonly lifecycleObservers = new Set<(event: TrackerProviderLifecycleEvent) => void>()

  constructor(ctx: Context) {
    super(ctx, 'tracker')
  }

  /**
   * Register one complete provider generation and synchronously publish its availability. The provider must use the
   * current interface version, declare every required capability, and have a unique id; violations throw without
   * changing the registry. The returned idempotent disposer stops admission to the generation, aborts and drains its
   * active operations, removes it, then publishes unavailability. Disposer cancellation is not supported.
   */
  register(provider: TrackerProvider): () => Promise<void> {
    if (provider.interfaceVersion !== TRACKER_INTERFACE_VERSION) {
      throw new TypeError(
        `tracker provider "${provider.id}" uses interface version ${String(provider.interfaceVersion)}; expected ${String(TRACKER_INTERFACE_VERSION)}`,
      )
    }
    if (this.providers.has(provider.id)) throw new Error(`tracker provider "${provider.id}" is already registered`)
    const missing = trackerCapabilities.filter((capability) => !provider.capabilities.includes(capability))
    if (missing.length > 0) {
      throw new TypeError(`tracker provider "${provider.id}" is missing capabilities: ${missing.join(', ')}`)
    }
    const registered: RegisteredProvider = {
      provider,
      controller: new AbortController(),
      active: new Set(),
      accepting: true,
    }
    this.providers.set(provider.id, registered)
    this.notifyProviderLifecycle({ kind: 'available', providerId: provider.id })

    return async () => {
      if (this.providers.get(provider.id) !== registered) return
      registered.accepting = false
      registered.controller.abort()
      await Promise.allSettled(registered.active)
      if (this.providers.get(provider.id) === registered) {
        this.providers.delete(provider.id)
        this.notifyProviderLifecycle({ kind: 'unavailable', providerId: provider.id })
      }
    }
  }

  /**
   * Observe future provider availability changes synchronously. Registration has no replay and no cancellation point;
   * observer failures are logged and do not block other observers. The returned idempotent function unsubscribes.
   */
  watchProviders(observer: (event: TrackerProviderLifecycleEvent) => void): () => void {
    this.lifecycleObservers.add(observer)
    return () => {
      this.lifecycleObservers.delete(observer)
    }
  }

  /**
   * Read one validated page through the currently registered provider generation. The optional cursor must have been
   * returned by that provider. Provider failures and withdrawal reject with `TrackerProviderError`; caller cancellation
   * rejects with its original reason. This operation has no durable or external-write effect.
   */
  async readCandidates(id: TrackerProviderId, cursor?: string, signal?: AbortSignal): Promise<TrackerCandidatePage> {
    return this.withProvider(id, (reader) => reader.readCandidates(cursor, signal))
  }

  /**
   * Retain the selected provider generation while an operation uses its reader. The provider must be available when
   * called. Provider withdrawal aborts its reads, waits for the callback to settle, and fences late results; consumer
   * failures are preserved. Effects performed by the callback are caller-owned and must occur only after awaited reader
   * operations succeed. `withProvider` itself has no independent caller-cancellation input.
   */
  async withProvider<T>(id: TrackerProviderId, operation: (reader: TrackerReader) => Promise<T>): Promise<T> {
    const registered = this.providers.get(id)
    if (registered === undefined || !registered.accepting) {
      throw new TrackerProviderError('provider-unavailable', `tracker provider "${id}" is unavailable`)
    }
    const reader: TrackerReader = {
      readCandidates: (cursor, signal) => this.readProviderCandidates(registered, cursor, signal),
      verifyIngress: (request, signal) => this.verifyProviderIngress(registered, request, signal),
    }
    let active: Promise<T>
    try {
      active = Promise.resolve(operation(reader))
    } catch (error) {
      active = Promise.reject(error)
    }
    registered.active.add(active)
    try {
      return await active
    } finally {
      registered.active.delete(active)
    }
  }

  private async readProviderCandidates(
    registered: RegisteredProvider,
    cursor?: string,
    callerSignal?: AbortSignal,
  ): Promise<TrackerCandidatePage> {
    callerSignal?.throwIfAborted()
    const request: TrackerReadRequest = {
      signal: this.combinedSignal(registered, callerSignal),
      ...(cursor === undefined ? {} : { cursor }),
    }
    let page: TrackerCandidatePage
    try {
      page = await registered.provider.readCandidates(request)
    } catch (error) {
      if (!registered.accepting) {
        throw new TrackerProviderError(
          'provider-unavailable',
          `tracker provider "${registered.provider.id}" was withdrawn`,
        )
      }
      callerSignal?.throwIfAborted()
      if (error instanceof TrackerProviderError) throw error
      throw new TrackerProviderError(
        'transient',
        `tracker provider "${registered.provider.id}" failed to read candidates`,
      )
    }
    if (!registered.accepting) {
      throw new TrackerProviderError(
        'provider-unavailable',
        `tracker provider "${registered.provider.id}" was withdrawn`,
      )
    }
    callerSignal?.throwIfAborted()
    const parsed = candidatePageSchema.safeParse(page)
    if (!parsed.success) {
      throw new TrackerProviderError(
        'invalid-response',
        `tracker provider "${registered.provider.id}" returned an invalid candidate page`,
      )
    }
    return {
      issues: parsed.data.issues,
      ...(parsed.data.nextCursor === undefined ? {} : { nextCursor: parsed.data.nextCursor }),
    }
  }

  private async verifyProviderIngress(
    registered: RegisteredProvider,
    request: TrackerIngressRequest,
    callerSignal?: AbortSignal,
  ): Promise<TrackerIngressDelivery> {
    callerSignal?.throwIfAborted()
    let delivery: TrackerIngressDelivery
    try {
      delivery = await registered.provider.verifyIngress({
        method: request.method,
        headers: request.headers.map((header) => ({ ...header })),
        body: request.body.slice(),
        signal: this.combinedSignal(registered, callerSignal),
      })
    } catch (error) {
      if (!registered.accepting) {
        throw new TrackerProviderError(
          'provider-unavailable',
          `tracker provider "${registered.provider.id}" was withdrawn`,
        )
      }
      callerSignal?.throwIfAborted()
      if (error instanceof TrackerProviderError) throw error
      throw new TrackerProviderError(
        'transient',
        `tracker provider "${registered.provider.id}" failed to verify ingress`,
      )
    }
    if (!registered.accepting) {
      throw new TrackerProviderError(
        'provider-unavailable',
        `tracker provider "${registered.provider.id}" was withdrawn`,
      )
    }
    callerSignal?.throwIfAborted()
    const parsed = ingressDeliverySchema.safeParse(delivery)
    if (!parsed.success || !parsed.data.deliveryId.startsWith(`${registered.provider.id}:`)) {
      throw new TrackerProviderError(
        'invalid-response',
        `tracker provider "${registered.provider.id}" returned an invalid ingress delivery`,
      )
    }
    return parsed.data
  }

  private combinedSignal(registered: RegisteredProvider, callerSignal?: AbortSignal): AbortSignal {
    return callerSignal === undefined
      ? registered.controller.signal
      : AbortSignal.any([registered.controller.signal, callerSignal])
  }

  private notifyProviderLifecycle(event: TrackerProviderLifecycleEvent): void {
    for (const observer of [...this.lifecycleObservers]) {
      try {
        observer(event)
      } catch {
        this.ctx.logger.warn('autopilot tracker provider lifecycle observer failed')
      }
    }
  }
}

export default Tracker
