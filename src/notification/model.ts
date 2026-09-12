declare const notificationProviderIdBrand: unique symbol
declare const notificationDestinationIdBrand: unique symbol

export type NotificationProviderId = string & { readonly [notificationProviderIdBrand]: true }
export type NotificationDestinationId = string & { readonly [notificationDestinationIdBrand]: true }

const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,255}$/

function opaqueId<T extends string>(kind: string, value: string): T {
  if (!ID_PATTERN.test(value)) throw new TypeError(`${kind} must match ${String(ID_PATTERN)}`)
  return value as T
}

export const notificationProviderId = (value: string): NotificationProviderId =>
  opaqueId<NotificationProviderId>('notification provider id', value)
export const notificationDestinationId = (value: string): NotificationDestinationId =>
  opaqueId<NotificationDestinationId>('notification destination id', value)

export const NOTIFICATION_INTERFACE_VERSION = 1 as const

export interface NotificationEvent {
  readonly version: 1
  readonly eventId: string
  readonly runId: string
  readonly timestamp: string
  readonly type: 'started' | 'blocked' | 'paused' | 'failed' | 'completed'
  readonly issueIdentity: string
  readonly displayKey: string
  readonly summary: string
  readonly actionNeeded?: string | undefined
  readonly runUrl: string
  readonly issueUrl: string
  readonly pullRequestUrl?: string | undefined
  readonly usage: { readonly kind: 'provider' | 'estimate' | 'unknown'; readonly tokens?: number | undefined }
}

export interface NotificationReceipt {
  readonly receiptId: string
  readonly receivedAt: string
}

export interface NotificationProviderRequest {
  readonly destinationId: NotificationDestinationId
  readonly event: NotificationEvent
  readonly signal: AbortSignal
}

export interface NotificationProvider {
  readonly id: NotificationProviderId
  readonly interfaceVersion: typeof NOTIFICATION_INTERFACE_VERSION
  readonly displayName: string
  readonly configurationNamespace: string
  reconcile(request: NotificationProviderRequest): Promise<NotificationReceipt | undefined>
  deliver(request: NotificationProviderRequest): Promise<NotificationReceipt>
}

export interface NotificationSender {
  reconcile(
    destinationId: NotificationDestinationId,
    event: NotificationEvent,
    signal?: AbortSignal,
  ): Promise<NotificationReceipt | undefined>
  deliver(
    destinationId: NotificationDestinationId,
    event: NotificationEvent,
    signal?: AbortSignal,
  ): Promise<NotificationReceipt>
}

export type NotificationProviderErrorCode =
  | 'authentication'
  | 'permission'
  | 'invalid-configuration'
  | 'permanent-rejection'
  | 'rate-limit'
  | 'timeout'
  | 'transient'
  | 'ambiguous-acknowledgement'
  | 'invalid-response'
  | 'provider-unavailable'

export class NotificationProviderError extends Error {
  constructor(
    readonly code: NotificationProviderErrorCode,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'NotificationProviderError'
  }
}
