import {
  NOTIFICATION_INTERFACE_VERSION,
  type NotificationEvent,
  type NotificationProvider,
  type NotificationReceipt,
  notificationProviderId,
} from '../notification.js'

export interface FixtureNotificationState {
  readonly events: Map<string, NotificationEvent>
}

export function createFixtureNotificationProvider(
  state: FixtureNotificationState,
  overrides: Partial<NotificationProvider> = {},
): NotificationProvider {
  return {
    id: notificationProviderId('fixture-notification'),
    interfaceVersion: NOTIFICATION_INTERFACE_VERSION,
    displayName: 'Fixture notification',
    configurationNamespace: 'fixture-notification',
    reconcile({ destinationId, event }) {
      const identity = deliveryIdentity(destinationId, event.eventId)
      return Promise.resolve(state.events.has(identity) ? receipt(identity) : undefined)
    },
    deliver({ destinationId, event }) {
      const identity = deliveryIdentity(destinationId, event.eventId)
      state.events.set(identity, structuredClone(event))
      return Promise.resolve(receipt(identity))
    },
    ...overrides,
  }
}

function receipt(eventId: string): NotificationReceipt {
  return { receiptId: `fixture:${eventId}`, receivedAt: '2026-09-11T00:00:00.000Z' }
}

function deliveryIdentity(destinationId: string, eventId: string): string {
  return `${destinationId}:${eventId}`
}
