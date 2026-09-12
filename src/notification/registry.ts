import { type Context, Service } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { GenerationRegistry, type ProviderGeneration } from '../providers/generation-registry.js'
import {
  NOTIFICATION_INTERFACE_VERSION,
  type NotificationDestinationId,
  type NotificationEvent,
  type NotificationProvider,
  NotificationProviderError,
  type NotificationProviderId,
  type NotificationProviderRequest,
  type NotificationReceipt,
  type NotificationSender,
} from './model.js'

const receiptSchema = z.object({
  receiptId: z.string().min(1).max(512),
  receivedAt: z.iso.datetime({ offset: true }),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    notifications: Notifications
  }
}

/** Registry for independently loaded notification transports; it stores no destinations, secrets, or delivery state. */
export class Notifications extends Service {
  private readonly providers = new GenerationRegistry<NotificationProviderId, NotificationProvider>()

  constructor(ctx: Context) {
    super(ctx, 'notifications')
  }

  register(provider: NotificationProvider): () => Promise<void> {
    if (provider.interfaceVersion !== NOTIFICATION_INTERFACE_VERSION) {
      throw new TypeError(
        `notification provider "${provider.id}" uses interface version ${String(provider.interfaceVersion)}; expected ${String(NOTIFICATION_INTERFACE_VERSION)}`,
      )
    }
    if (this.providers.has(provider.id)) throw new Error(`notification provider "${provider.id}" is already registered`)
    return this.providers.register(provider.id, provider)
  }

  async withProvider<T>(id: NotificationProviderId, operation: (sender: NotificationSender) => Promise<T>): Promise<T> {
    const registered = this.providers.require(
      id,
      () => new NotificationProviderError('provider-unavailable', `notification provider "${id}" is unavailable`),
    )
    const sender: NotificationSender = {
      reconcile: (destinationId, event, signal) => this.invoke(registered, 'reconcile', destinationId, event, signal),
      deliver: async (destinationId, event, signal) => {
        const receipt = await this.invoke(registered, 'deliver', destinationId, event, signal)
        if (receipt === undefined) {
          throw new NotificationProviderError('invalid-response', 'notification provider omitted its delivery receipt')
        }
        return receipt
      },
    }
    return await this.providers.retain(registered, () => operation(sender))
  }

  private async invoke(
    registered: ProviderGeneration<NotificationProvider>,
    operation: 'reconcile' | 'deliver',
    destinationId: NotificationDestinationId,
    event: NotificationEvent,
    callerSignal?: AbortSignal,
  ): Promise<NotificationReceipt | undefined> {
    callerSignal?.throwIfAborted()
    const request: NotificationProviderRequest = {
      destinationId,
      event: structuredClone(event),
      signal: this.providers.signal(registered, callerSignal),
    }
    try {
      const result = await registered.provider[operation](request)
      this.providers.assertCurrent(registered, () => withdrawn(registered.provider.id, operation))
      callerSignal?.throwIfAborted()
      return result === undefined ? undefined : receiptSchema.parse(result)
    } catch (error) {
      if (!registered.accepting) throw withdrawn(registered.provider.id, operation)
      callerSignal?.throwIfAborted()
      if (error instanceof NotificationProviderError) throw error
      if (error instanceof z.ZodError) {
        throw new NotificationProviderError('invalid-response', 'notification provider returned an invalid receipt')
      }
      throw new NotificationProviderError('transient', 'notification provider delivery failed')
    }
  }
}

function withdrawn(id: NotificationProviderId, operation: 'reconcile' | 'deliver'): NotificationProviderError {
  return new NotificationProviderError(
    operation === 'deliver' ? 'ambiguous-acknowledgement' : 'provider-unavailable',
    `notification provider "${id}" was withdrawn`,
  )
}

export default Notifications
