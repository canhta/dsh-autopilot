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
  return {
    id: trackerProviderId('fixture'),
    interfaceVersion: TRACKER_INTERFACE_VERSION,
    displayName: 'Fixture tracker',
    configurationNamespace: 'fixture-tracker',
    capabilities: ['candidates', 'comments', 'dependencies', 'readiness', 'ingress'],
    readCandidates: () => Promise.resolve({ issues }),
    verifyIngress: () => Promise.resolve({ deliveryId: 'fixture:delivery-1' }),
    ...overrides,
  }
}
