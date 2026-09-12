import {
  TRACKER_INTERFACE_VERSION,
  type TrackerIssueSnapshot,
  type TrackerProvider,
  trackerProviderId,
} from '../tracker.js'

export interface FixtureTrackerProviderOptions extends Partial<TrackerProvider> {
  issues: readonly TrackerIssueSnapshot[]
}

/** Build a deterministic external adapter for tracker conformance and integration tests. */
export function createFixtureTrackerProvider(options: FixtureTrackerProviderOptions): TrackerProvider {
  const { issues, ...overrides } = options
  const delivered = new Set<string>()
  return {
    id: trackerProviderId('fixture'),
    interfaceVersion: TRACKER_INTERFACE_VERSION,
    displayName: 'Fixture tracker',
    configurationNamespace: 'fixture-tracker',
    capabilities: ['candidates', 'comments', 'dependencies', 'readiness', 'ingress', 'reports', 'projections'],
    readCandidates: () => Promise.resolve({ issues }),
    verifyIngress: () => Promise.resolve({ deliveryId: 'fixture:delivery-1' }),
    reconcileDelivery: ({ delivery }) =>
      Promise.resolve(
        delivered.has(delivery.deliveryId)
          ? {
              kind: 'delivered' as const,
              receipt: { receiptId: `fixture:${delivery.deliveryId}`, receivedAt: '2026-09-11T00:00:00.000Z' },
            }
          : { kind: 'missing' as const },
      ),
    deliver: ({ delivery }) => {
      delivered.add(delivery.deliveryId)
      return Promise.resolve({
        receiptId: `fixture:${delivery.deliveryId}`,
        receivedAt: '2026-09-11T00:00:00.000Z',
      })
    },
    ...overrides,
  }
}
