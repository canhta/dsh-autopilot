import { credentialRef } from '@deepseek-ai/dsh-credentials'
import s from '@deepseek-ai/schemastery'
import { notificationDestinationId } from '../../notification.js'
import { validateDestinationUrl } from '../notification-http.js'

export interface NtfyNotificationSettings {
  destinations: Array<{ id: string; serverUrl: string; topic: string; tokenCredentialRef: string }>
  timeoutMs: number
}

export const ntfyNotificationSettingsSchema: s<NtfyNotificationSettings> = s.object({
  destinations: s
    .array(
      s.object({
        id: s.string().required(),
        serverUrl: s.string().required(),
        topic: s.string().required(),
        tokenCredentialRef: s.string().default(''),
      }),
    )
    .default([]),
  timeoutMs: s.number().min(1_000).max(30_000).default(10_000),
})

export function validateNtfySettings(config: NtfyNotificationSettings): void {
  if (!Number.isInteger(config.timeoutMs)) throw new TypeError('ntfy timeout must be an integer')
  if (config.destinations.length > 32) throw new TypeError('ntfy destinations exceed the configured bound')
  const ids = new Set<string>()
  for (const destination of config.destinations) {
    notificationDestinationId(destination.id)
    if (ids.has(destination.id)) throw new TypeError('ntfy destination ids must be unique')
    ids.add(destination.id)
    validateDestinationUrl(destination.serverUrl, 'ntfy server URL')
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(destination.topic)) throw new TypeError('ntfy topic is invalid')
    if (destination.tokenCredentialRef !== '') credentialRef(destination.tokenCredentialRef)
  }
}
