import { type Context, Service } from '@deepseek-ai/cordis'
import { GenerationRegistry, type ProviderGeneration } from '../providers/generation-registry.js'
import {
  TRACKER_INTERFACE_VERSION,
  type TrackerCandidatePage,
  type TrackerDeliveryObservation,
  type TrackerIngressDelivery,
  type TrackerIngressRequest,
  type TrackerOutboundDelivery,
  type TrackerOutboundReceipt,
  type TrackerProvider,
  TrackerProviderError,
  type TrackerProviderId,
  type TrackerProviderLifecycleEvent,
  type TrackerProviderRegistration,
  type TrackerReader,
  type TrackerReadRequest,
  type TrackerWriter,
  trackerCapabilities,
  trackerWriteCapabilities,
} from './model.js'
import {
  candidatePageSchema,
  deliveryObservationSchema,
  ingressDeliverySchema,
  outboundReceiptSchema,
} from './validation.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tracker: Tracker
  }
}

/** Provider registry and normalized read seam consumed by admission. */
export class Tracker extends Service {
  private readonly lifecycleObservers = new Set<(event: TrackerProviderLifecycleEvent) => void>()
  private readonly providers = new GenerationRegistry<TrackerProviderId, TrackerProvider>(
    (providerId) => this.notifyProviderLifecycle({ kind: 'available', providerId }),
    (providerId) => this.notifyProviderLifecycle({ kind: 'unavailable', providerId }),
  )

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
    const writes = trackerWriteCapabilities.filter((capability) => provider.capabilities.includes(capability))
    if (
      writes.length > 0 &&
      (writes.length !== trackerWriteCapabilities.length ||
        provider.reconcileDelivery === undefined ||
        provider.deliver === undefined)
    ) {
      throw new TypeError(`tracker provider "${provider.id}" must implement reports and projections together`)
    }
    return this.providers.register(provider.id, provider)
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

  /** Return stable, secret-free metadata for every currently accepting provider generation. */
  providerRegistrations(): readonly TrackerProviderRegistration[] {
    return [...this.providers.values()]
      .filter((registered) => registered.accepting)
      .map(({ provider }) => ({
        id: provider.id,
        displayName: provider.displayName,
        configurationNamespace: provider.configurationNamespace,
        capabilities: [...provider.capabilities],
      }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id))
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
    const registered = this.providers.require(
      id,
      () => new TrackerProviderError('provider-unavailable', `tracker provider "${id}" is unavailable`),
    )
    const reader: TrackerReader = {
      readCandidates: (cursor, signal) => this.readProviderCandidates(registered, cursor, signal),
      verifyIngress: (request, signal) => this.verifyProviderIngress(registered, request, signal),
    }
    return await this.providers.retain(registered, () => operation(reader))
  }

  /** Retain one write-capable provider generation while a durable delivery owner reconciles and applies its intent. */
  async withWriter<T>(id: TrackerProviderId, operation: (writer: TrackerWriter) => Promise<T>): Promise<T> {
    const registered = this.providers.require(
      id,
      () => new TrackerProviderError('provider-unavailable', `tracker provider "${id}" is unavailable`),
    )
    if (
      !registered.accepting ||
      registered.provider.reconcileDelivery === undefined ||
      registered.provider.deliver === undefined ||
      !trackerWriteCapabilities.every((capability) => registered.provider.capabilities.includes(capability))
    ) {
      throw new TrackerProviderError('unsupported-capability', `tracker provider "${id}" has no outbound delivery seam`)
    }
    const writer: TrackerWriter = {
      reconcileDelivery: (delivery, signal) => this.reconcileProviderDelivery(registered, delivery, signal),
      deliver: (delivery, signal) => this.deliverProviderIntent(registered, delivery, signal),
    }
    return await this.providers.retain(registered, () => operation(writer))
  }

  private async readProviderCandidates(
    registered: ProviderGeneration<TrackerProvider>,
    cursor?: string,
    callerSignal?: AbortSignal,
  ): Promise<TrackerCandidatePage> {
    callerSignal?.throwIfAborted()
    const request: TrackerReadRequest = {
      signal: this.providers.signal(registered, callerSignal),
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
    registered: ProviderGeneration<TrackerProvider>,
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
        signal: this.providers.signal(registered, callerSignal),
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

  private async reconcileProviderDelivery(
    registered: ProviderGeneration<TrackerProvider>,
    delivery: TrackerOutboundDelivery,
    callerSignal?: AbortSignal,
  ): Promise<TrackerDeliveryObservation> {
    const value = await this.invokeWrite(registered, 'reconcileDelivery', delivery, callerSignal)
    const parsed = deliveryObservationSchema.safeParse(value)
    if (!parsed.success) {
      throw new TrackerProviderError('invalid-response', 'tracker provider returned an invalid delivery observation')
    }
    return parsed.data
  }

  private async deliverProviderIntent(
    registered: ProviderGeneration<TrackerProvider>,
    delivery: TrackerOutboundDelivery,
    callerSignal?: AbortSignal,
  ): Promise<TrackerOutboundReceipt> {
    const value = await this.invokeWrite(registered, 'deliver', delivery, callerSignal)
    const parsed = outboundReceiptSchema.safeParse(value)
    if (!parsed.success)
      throw new TrackerProviderError('invalid-response', 'tracker provider returned an invalid receipt')
    return parsed.data
  }

  private async invokeWrite(
    registered: ProviderGeneration<TrackerProvider>,
    operation: 'reconcileDelivery' | 'deliver',
    delivery: TrackerOutboundDelivery,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    callerSignal?.throwIfAborted()
    try {
      const request = {
        delivery: structuredClone(delivery),
        signal: this.providers.signal(registered, callerSignal),
      }
      const value =
        operation === 'reconcileDelivery'
          ? await registered.provider.reconcileDelivery?.(request)
          : await registered.provider.deliver?.(request)
      if (value === undefined) throw new TrackerProviderError('unsupported-capability', 'tracker write is unavailable')
      if (!registered.accepting) {
        throw new TrackerProviderError(
          operation === 'deliver' ? 'ambiguous-acknowledgement' : 'provider-unavailable',
          `tracker provider "${registered.provider.id}" was withdrawn`,
        )
      }
      callerSignal?.throwIfAborted()
      return value
    } catch (error) {
      if (!registered.accepting) {
        throw new TrackerProviderError(
          operation === 'deliver' ? 'ambiguous-acknowledgement' : 'provider-unavailable',
          `tracker provider "${registered.provider.id}" was withdrawn`,
        )
      }
      callerSignal?.throwIfAborted()
      if (error instanceof TrackerProviderError) throw error
      throw new TrackerProviderError(
        'transient',
        `tracker provider "${registered.provider.id}" failed outbound delivery`,
      )
    }
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
