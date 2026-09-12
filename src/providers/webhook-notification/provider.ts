import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import {
  NOTIFICATION_INTERFACE_VERSION,
  type NotificationProvider,
  NotificationProviderError,
  notificationProviderId,
} from '../../notification.js'
import { acknowledgedReceipt, authorizationHeader, postNotification } from '../notification-http.js'
import {
  validateWebhookSettings,
  type WebhookNotificationSettings,
  webhookNotificationSettingsSchema,
} from './settings.js'

export const name = 'dsh-autopilot-webhook-notification'
export const inject = ['notifications', 'settings', 'credentials']

export async function apply(ctx: Context): Promise<void> {
  const settings = ctx.settings.register('dsh-autopilot-webhook-notification', webhookNotificationSettingsSchema, {
    validate: validateWebhookSettings,
  })
  await ctx.effect(async () => {
    let snapshot = structuredClone(settings.get())
    let dispose = ctx.notifications.register(createWebhookProvider(ctx, snapshot))
    let queue = Promise.resolve()
    const stop = settings.watch((next) => {
      if (isDeepStrictEqual(snapshot, next)) return
      queue = queue.then(async () => {
        await dispose()
        snapshot = structuredClone(next)
        dispose = ctx.notifications.register(createWebhookProvider(ctx, snapshot))
      })
      return queue
    })
    return async () => {
      stop()
      await queue
      await dispose()
    }
  }, 'dsh-autopilot-webhook-notification.provider')
}

function createWebhookProvider(ctx: Context, config: Readonly<WebhookNotificationSettings>): NotificationProvider {
  validateWebhookSettings(config)
  return {
    id: notificationProviderId('webhook'),
    interfaceVersion: NOTIFICATION_INTERFACE_VERSION,
    displayName: 'Generic webhook',
    configurationNamespace: 'dsh-autopilot-webhook-notification',
    reconcile: () => Promise.resolve(undefined),
    async deliver({ destinationId, event, signal }) {
      const destination = config.destinations.find((candidate) => candidate.id === destinationId)
      if (destination === undefined) {
        throw new NotificationProviderError('invalid-configuration', 'webhook destination is not configured')
      }
      const auth = await authorizationHeader(ctx, destination.authorizationCredentialRef)
      signal.throwIfAborted()
      const { response } = await postNotification(
        destination,
        JSON.stringify(event),
        {
          'content-type': 'application/json',
          'x-autopilot-event-id': event.eventId,
          'idempotency-key': event.eventId,
          ...auth,
        },
        config.timeoutMs,
        signal,
        'ignore',
      )
      return acknowledgedReceipt('webhook', event.eventId, response)
    },
  }
}
