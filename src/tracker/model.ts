declare const trackerProviderIdBrand: unique symbol
declare const trackerBindingIdBrand: unique symbol
declare const trackerIssueIdBrand: unique symbol
declare const trackerCommentIdBrand: unique symbol
declare const readinessGenerationBrand: unique symbol

/** Validated stable identity of one tracker provider implementation. */
export type TrackerProviderId = string & { readonly [trackerProviderIdBrand]: true }
/** Validated identity of the configured project or workspace binding that supplied an issue. */
export type TrackerBindingId = string & { readonly [trackerBindingIdBrand]: true }
/** Validated provider-native issue identity, independent of its display key. */
export type TrackerIssueId = string & { readonly [trackerIssueIdBrand]: true }
/** Validated provider-native comment identity. */
export type TrackerCommentId = string & { readonly [trackerCommentIdBrand]: true }
/** Validated identity of the human readiness transition authorizing one run. */
export type ReadinessGeneration = string & { readonly [readinessGenerationBrand]: true }

const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,255}$/

function opaqueId<T extends string>(kind: string, value: string): T {
  if (!ID_PATTERN.test(value)) throw new TypeError(`${kind} must match ${String(ID_PATTERN)}`)
  return value as T
}

/** Validate and brand a provider id; throws `TypeError` for an invalid external value and has no cancellation point. */
export const trackerProviderId = (value: string): TrackerProviderId =>
  opaqueId<TrackerProviderId>('tracker provider id', value)
/** Validate and brand a binding id; throws `TypeError` for an invalid external value and has no cancellation point. */
export const trackerBindingId = (value: string): TrackerBindingId =>
  opaqueId<TrackerBindingId>('tracker binding id', value)
/** Validate and brand an issue id; throws `TypeError` for an invalid external value and has no cancellation point. */
export const trackerIssueId = (value: string): TrackerIssueId => opaqueId<TrackerIssueId>('tracker issue id', value)
/** Validate and brand a comment id; throws `TypeError` for an invalid external value and has no cancellation point. */
export const trackerCommentId = (value: string): TrackerCommentId =>
  opaqueId<TrackerCommentId>('tracker comment id', value)
/**
 * Validate and brand a readiness-generation id; throws `TypeError` for an invalid external value and has no
 * cancellation point.
 */
export const readinessGeneration = (value: string): ReadinessGeneration =>
  opaqueId<ReadinessGeneration>('readiness generation', value)

/** Exact provider contract version accepted by this build. */
export const TRACKER_INTERFACE_VERSION = 2 as const
/** Capabilities every provider generation must implement before registration succeeds. */
export const trackerCapabilities = ['candidates', 'comments', 'dependencies', 'readiness', 'ingress'] as const
/** Capability name declared by a compatible provider generation. */
export type TrackerCapability = (typeof trackerCapabilities)[number]

/** Immutable comment data used to select and retain the Agent Brief. */
export interface TrackerComment {
  id: TrackerCommentId
  authorId: string
  body: string
  updatedAt: string
}

/** Current completion observation for an issue that blocks a candidate. */
export interface TrackerDependency {
  issueId: TrackerIssueId
  displayKey: string
  state: 'completed' | 'not-completed' | 'unknown'
}

/** Human readiness evidence, or its explicit absence, at the time of the provider read. */
export type TrackerReadiness =
  | { kind: 'absent' }
  | {
      kind: 'transition'
      generation: ReadinessGeneration
      actorId: string
      actorKind: 'human' | 'automation' | 'unknown'
      occurredAt: string
    }

/** Complete, bounded issue projection consumed by admission policy. */
export interface TrackerIssueSnapshot {
  bindingId: TrackerBindingId
  issueId: TrackerIssueId
  displayKey: string
  summary: string
  priorityRank: number
  isReady: boolean
  labels: readonly string[]
  comments: readonly TrackerComment[]
  dependencies: readonly TrackerDependency[]
  readiness: TrackerReadiness
}

/** One validated provider page and its opaque continuation cursor. */
export interface TrackerCandidatePage {
  issues: readonly TrackerIssueSnapshot[]
  nextCursor?: string
}

/** Generation- and caller-cancellable input supplied to a provider candidate read. */
export interface TrackerReadRequest {
  /** Aborts when either the provider generation is withdrawn or the calling operation is cancelled. */
  signal: AbortSignal
  cursor?: string
}

/** One raw ingress header; repeated names remain separate entries. */
export interface TrackerIngressHeader {
  name: string
  value: string
}

/** Detached, bounded HTTP input passed from the Host adapter to the selected provider. */
export interface TrackerIngressRequest {
  /** HTTP method received by the Host ingress adapter. */
  method: string
  /** Raw headers with duplicates preserved so the provider can reject ambiguous authentication input. */
  headers: readonly TrackerIngressHeader[]
  /** Detached, bounded request bytes. */
  body: Uint8Array
}

/** Ingress input extended with the operation's combined cancellation signal. */
export interface TrackerProviderIngressRequest extends TrackerIngressRequest {
  /** Aborts when either the provider generation is withdrawn or the calling operation is cancelled. */
  signal: AbortSignal
}

/** Authentication result whose id is stable across retries and qualified by provider id. */
export interface TrackerIngressDelivery {
  /** Provider-qualified delivery id safe to retain in durable admission state. */
  deliveryId: string
}

/** Non-replayed availability transition for one provider generation. */
export interface TrackerProviderLifecycleEvent {
  kind: 'available' | 'unavailable'
  providerId: TrackerProviderId
}

/** Versioned read-only tracker adapter registered as one lifecycle-owned generation. */
export interface TrackerProvider {
  id: TrackerProviderId
  interfaceVersion: typeof TRACKER_INTERFACE_VERSION
  displayName: string
  configurationNamespace: string
  capabilities: readonly TrackerCapability[]
  /**
   * Read one provider page without external writes. The cursor, when present, must come from the preceding page.
   * Resolve with provider data or reject with `TrackerProviderError`; reject with the signal reason when cancelled.
   */
  readCandidates(request: TrackerReadRequest): Promise<TrackerCandidatePage>
  /**
   * Authenticate a bounded raw ingress request without retaining a receipt or making external writes. Resolve with a
   * provider-qualified, retry-stable delivery id; reject with `TrackerProviderError` for authentication or malformed
   * input and reject with the signal reason when cancelled.
   */
  verifyIngress(request: TrackerProviderIngressRequest): Promise<TrackerIngressDelivery>
}

/** A generation-scoped, normalized provider view valid only during its `Tracker.withProvider` callback. */
export interface TrackerReader {
  /**
   * Read and validate one candidate page. A supplied caller signal is combined with provider-withdrawal cancellation;
   * caller cancellation rejects with its original reason, while withdrawal and provider failures are normalized as
   * `TrackerProviderError`. This operation has no durable or external-write effect.
   */
  readCandidates(cursor?: string, signal?: AbortSignal): Promise<TrackerCandidatePage>
  /**
   * Authenticate and validate detached ingress bytes. A supplied caller signal is combined with provider-withdrawal
   * cancellation; caller cancellation rejects with its original reason, while withdrawal and provider failures are
   * normalized as `TrackerProviderError`. Successful verification does not retain a receipt.
   */
  verifyIngress(request: TrackerIngressRequest, signal?: AbortSignal): Promise<TrackerIngressDelivery>
}

/** Stable failure classification safe for scheduling, diagnostics, and HTTP mapping. */
export type TrackerProviderErrorCode =
  | 'authentication'
  | 'permission'
  | 'invalid-configuration'
  | 'not-found'
  | 'conflict'
  | 'rate-limit'
  | 'timeout'
  | 'transient'
  | 'unsupported-capability'
  | 'ambiguous-acknowledgement'
  | 'invalid-response'
  | 'provider-unavailable'

/** Normalized operational failure at the tracker-provider boundary. */
export class TrackerProviderError extends Error {
  /** Construct a provider-safe failure; retry delay is meaningful only for retryable codes and cannot be cancelled. */
  constructor(
    readonly code: TrackerProviderErrorCode,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'TrackerProviderError'
  }
}
