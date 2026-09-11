declare const trackerProviderIdBrand: unique symbol
declare const trackerBindingIdBrand: unique symbol
declare const trackerIssueIdBrand: unique symbol
declare const trackerCommentIdBrand: unique symbol
declare const readinessGenerationBrand: unique symbol

export type TrackerProviderId = string & { readonly [trackerProviderIdBrand]: true }
export type TrackerBindingId = string & { readonly [trackerBindingIdBrand]: true }
export type TrackerIssueId = string & { readonly [trackerIssueIdBrand]: true }
export type TrackerCommentId = string & { readonly [trackerCommentIdBrand]: true }
export type ReadinessGeneration = string & { readonly [readinessGenerationBrand]: true }

const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,255}$/

function opaqueId<T extends string>(kind: string, value: string): T {
  if (!ID_PATTERN.test(value)) throw new TypeError(`${kind} must match ${String(ID_PATTERN)}`)
  return value as T
}

export const trackerProviderId = (value: string): TrackerProviderId =>
  opaqueId<TrackerProviderId>('tracker provider id', value)
export const trackerBindingId = (value: string): TrackerBindingId =>
  opaqueId<TrackerBindingId>('tracker binding id', value)
export const trackerIssueId = (value: string): TrackerIssueId => opaqueId<TrackerIssueId>('tracker issue id', value)
export const trackerCommentId = (value: string): TrackerCommentId =>
  opaqueId<TrackerCommentId>('tracker comment id', value)
export const readinessGeneration = (value: string): ReadinessGeneration =>
  opaqueId<ReadinessGeneration>('readiness generation', value)

export const TRACKER_INTERFACE_VERSION = 2 as const
export const trackerCapabilities = ['candidates', 'comments', 'dependencies', 'readiness', 'ingress'] as const
export type TrackerCapability = (typeof trackerCapabilities)[number]

export interface TrackerComment {
  id: TrackerCommentId
  authorId: string
  body: string
  updatedAt: string
}

export interface TrackerDependency {
  issueId: TrackerIssueId
  displayKey: string
  state: 'completed' | 'not-completed' | 'unknown'
}

export type TrackerReadiness =
  | { kind: 'absent' }
  | {
      kind: 'transition'
      generation: ReadinessGeneration
      actorId: string
      actorKind: 'human' | 'automation' | 'unknown'
      occurredAt: string
    }

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

export interface TrackerCandidatePage {
  issues: readonly TrackerIssueSnapshot[]
  nextCursor?: string
}

export interface TrackerReadRequest {
  signal: AbortSignal
  cursor?: string
}

export interface TrackerIngressHeader {
  name: string
  value: string
}

export interface TrackerIngressRequest {
  method: string
  headers: readonly TrackerIngressHeader[]
  body: Uint8Array
}

export interface TrackerProviderIngressRequest extends TrackerIngressRequest {
  signal: AbortSignal
}

export interface TrackerIngressDelivery {
  deliveryId: string
}

export interface TrackerProviderLifecycleEvent {
  kind: 'available' | 'unavailable'
  providerId: TrackerProviderId
}

export interface TrackerProvider {
  id: TrackerProviderId
  interfaceVersion: typeof TRACKER_INTERFACE_VERSION
  displayName: string
  configurationNamespace: string
  capabilities: readonly TrackerCapability[]
  readCandidates(request: TrackerReadRequest): Promise<TrackerCandidatePage>
  verifyIngress(request: TrackerProviderIngressRequest): Promise<TrackerIngressDelivery>
}

export interface TrackerReader {
  readCandidates(cursor?: string): Promise<TrackerCandidatePage>
  verifyIngress(request: TrackerIngressRequest): Promise<TrackerIngressDelivery>
}

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

export class TrackerProviderError extends Error {
  constructor(
    readonly code: TrackerProviderErrorCode,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'TrackerProviderError'
  }
}
