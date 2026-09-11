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

  /** Register one complete provider generation until its async disposer drains active operations. */
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

  watchProviders(observer: (event: TrackerProviderLifecycleEvent) => void): () => void {
    this.lifecycleObservers.add(observer)
    return () => {
      this.lifecycleObservers.delete(observer)
    }
  }

  async readCandidates(id: TrackerProviderId, cursor?: string): Promise<TrackerCandidatePage> {
    return this.withProvider(id, (reader) => reader.readCandidates(cursor))
  }

  async withProvider<T>(id: TrackerProviderId, operation: (reader: TrackerReader) => Promise<T>): Promise<T> {
    const registered = this.providers.get(id)
    if (registered === undefined || !registered.accepting) {
      throw new TrackerProviderError('provider-unavailable', `tracker provider "${id}" is unavailable`)
    }
    const reader: TrackerReader = {
      readCandidates: (cursor) => this.readProviderCandidates(registered, cursor),
      verifyIngress: (request) => this.verifyProviderIngress(registered, request),
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

  private async readProviderCandidates(registered: RegisteredProvider, cursor?: string): Promise<TrackerCandidatePage> {
    const request: TrackerReadRequest = {
      signal: registered.controller.signal,
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
  ): Promise<TrackerIngressDelivery> {
    let delivery: TrackerIngressDelivery
    try {
      delivery = await registered.provider.verifyIngress({
        method: request.method,
        headers: request.headers.map((header) => ({ ...header })),
        body: request.body.slice(),
        signal: registered.controller.signal,
      })
    } catch (error) {
      if (!registered.accepting) {
        throw new TrackerProviderError(
          'provider-unavailable',
          `tracker provider "${registered.provider.id}" was withdrawn`,
        )
      }
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
    const parsed = ingressDeliverySchema.safeParse(delivery)
    if (!parsed.success || !parsed.data.deliveryId.startsWith(`${registered.provider.id}:`)) {
      throw new TrackerProviderError(
        'invalid-response',
        `tracker provider "${registered.provider.id}" returned an invalid ingress delivery`,
      )
    }
    return parsed.data
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
