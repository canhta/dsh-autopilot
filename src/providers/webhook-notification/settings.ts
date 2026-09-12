import { credentialRef } from '@deepseek-ai/dsh-credentials'
import s from '@deepseek-ai/schemastery'
import { notificationDestinationId } from '../../notification.js'
import { validateDestinationUrl } from '../notification-http.js'

export interface WebhookNotificationSettings {
  destinations: Array<{ id: string; url: string; authorizationCredentialRef: string }>
  timeoutMs: number
}

export const webhookNotificationSettingsSchema: s<WebhookNotificationSettings> = s.object({
  destinations: s
    .array(
      s.object({
        id: s.string().required(),
        url: s.string().required(),
        authorizationCredentialRef: s.string().default(''),
      }),
    )
    .default([]),
  timeoutMs: s.number().min(1_000).max(30_000).default(10_000),
})

export function validateWebhookSettings(config: WebhookNotificationSettings): void {
  if (!Number.isInteger(config.timeoutMs)) throw new TypeError('webhook timeout must be an integer')
  if (config.destinations.length > 32) throw new TypeError('webhook destinations exceed the configured bound')
  const ids = new Set<string>()
  for (const destination of config.destinations) {
    notificationDestinationId(destination.id)
    if (ids.has(destination.id)) throw new TypeError('webhook destination ids must be unique')
    ids.add(destination.id)
    validateDestinationUrl(destination.url, 'webhook destination URL')
    if (destination.authorizationCredentialRef !== '') credentialRef(destination.authorizationCredentialRef)
  }
}
