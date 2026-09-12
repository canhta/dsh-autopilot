import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import {
  NOTIFICATION_INTERFACE_VERSION,
  type NotificationProvider,
  NotificationProviderError,
  notificationProviderId,
} from '../../notification.js'
import { authorizationHeader, postNotification } from '../notification-http.js'
import { type NtfyNotificationSettings, ntfyNotificationSettingsSchema, validateNtfySettings } from './settings.js'

const responseSchema = z.object({ id: z.string().min(1).max(256), time: z.number().int().nonnegative() })

export const name = 'dsh-autopilot-ntfy-notification'
export const inject = ['notifications', 'settings', 'credentials']

export async function apply(ctx: Context): Promise<void> {
  const settings = ctx.settings.register('dsh-autopilot-ntfy-notification', ntfyNotificationSettingsSchema, {
    validate: validateNtfySettings,
  })
  await ctx.effect(async () => {
    let snapshot = structuredClone(settings.get())
    let dispose = ctx.notifications.register(createNtfyProvider(ctx, snapshot))
    let queue = Promise.resolve()
    const stop = settings.watch((next) => {
      if (isDeepStrictEqual(snapshot, next)) return
      queue = queue.then(async () => {
        await dispose()
        snapshot = structuredClone(next)
        dispose = ctx.notifications.register(createNtfyProvider(ctx, snapshot))
      })
      return queue
    })
    return async () => {
      stop()
      await queue
      await dispose()
    }
  }, 'dsh-autopilot-ntfy-notification.provider')
}

function createNtfyProvider(ctx: Context, config: Readonly<NtfyNotificationSettings>): NotificationProvider {
  validateNtfySettings(config)
  return {
    id: notificationProviderId('ntfy'),
    interfaceVersion: NOTIFICATION_INTERFACE_VERSION,
    displayName: 'ntfy',
    configurationNamespace: 'dsh-autopilot-ntfy-notification',
    reconcile: () => Promise.resolve(undefined),
    async deliver({ destinationId, event, signal }) {
      const destination = config.destinations.find((candidate) => candidate.id === destinationId)
      if (destination === undefined) {
        throw new NotificationProviderError('invalid-configuration', 'ntfy destination is not configured')
      }
      const auth = await authorizationHeader(ctx, destination.tokenCredentialRef)
      signal.throwIfAborted()
      const { text } = await postNotification(
        { url: destination.serverUrl, authorizationCredentialRef: destination.tokenCredentialRef },
        JSON.stringify({
          topic: destination.topic,
          title: `${event.displayKey}: ${event.type}`,
          message: ntfyMessage(event),
          click: event.pullRequestUrl ?? event.runUrl,
          actions: [{ action: 'view', label: 'Open run', url: event.runUrl }],
        }),
        { 'content-type': 'application/json', 'x-autopilot-event-id': event.eventId, ...auth },
        config.timeoutMs,
        signal,
        'bounded',
      )
      let parsed: z.infer<typeof responseSchema>
      try {
        parsed = responseSchema.parse(JSON.parse(text))
      } catch {
        throw new NotificationProviderError('invalid-response', 'ntfy returned an invalid acknowledgement')
      }
      const receivedAt = new Date(parsed.time * 1_000)
      if (Number.isNaN(receivedAt.getTime())) {
        throw new NotificationProviderError('invalid-response', 'ntfy returned an invalid acknowledgement time')
      }
      return { receiptId: `ntfy:${parsed.id}`, receivedAt: receivedAt.toISOString() }
    },
  }
}

function ntfyMessage(event: import('../../notification.js').NotificationEvent): string {
  const lines = [
    `Autopilot notification v${String(event.version)}`,
    event.summary,
    `Event: ${event.eventId}`,
    `Run: ${event.runId} ${event.runUrl}`,
    `Issue: ${event.issueIdentity} (${event.displayKey}) ${event.issueUrl}`,
    `Type: ${event.type}`,
    ...(event.actionNeeded === undefined ? [] : [`Action needed: ${event.actionNeeded}`]),
    ...(event.pullRequestUrl === undefined ? [] : [`Pull request: ${event.pullRequestUrl}`]),
    `Usage: ${event.usage.kind}${event.usage.tokens === undefined ? '' : ` ${String(event.usage.tokens)} tokens`}`,
  ]
  const message = lines.join('\n')
  if (new TextEncoder().encode(message).byteLength > 4_096) {
    throw new NotificationProviderError('permanent-rejection', 'ntfy notification exceeds its payload bound')
  }
  return message
}
