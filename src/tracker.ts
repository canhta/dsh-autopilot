import { type Context, Service } from '@deepseek-ai/cordis'
import { z } from 'zod'

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
  if (!ID_PATTERN.test(value)) {
    throw new TypeError(`${kind} must match ${String(ID_PATTERN)}`)
  }
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

export const TRACKER_INTERFACE_VERSION = 1 as const

export const trackerCapabilities = ['candidates', 'comments', 'dependencies', 'readiness'] as const
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

export interface TrackerProvider {
  id: TrackerProviderId
  interfaceVersion: typeof TRACKER_INTERFACE_VERSION
  displayName: string
  configurationNamespace: string
  capabilities: readonly TrackerCapability[]
  readCandidates(request: TrackerReadRequest): Promise<TrackerCandidatePage>
}

export interface TrackerReader {
  readCandidates(cursor?: string): Promise<TrackerCandidatePage>
}

export type TrackerProviderErrorCode =
  | 'authentication'
  | 'permission'
  | 'invalid-configuration'
  | 'not-found'
  | 'conflict'
  | 'rate-limit'
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

const commentSchema = z.object({
  id: z.string().min(1).max(256).transform(trackerCommentId),
  authorId: z.string().min(1).max(256),
  body: z.string(),
  updatedAt: z.iso.datetime({ offset: true }),
})

const dependencySchema = z.object({
  issueId: z.string().min(1).max(256).transform(trackerIssueId),
  displayKey: z.string().min(1).max(256),
  state: z.enum(['completed', 'not-completed', 'unknown']),
})

const readinessSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('absent') }),
  z.object({
    kind: z.literal('transition'),
    generation: z.string().min(1).max(256).transform(readinessGeneration),
    actorId: z.string().min(1).max(256),
    actorKind: z.enum(['human', 'automation', 'unknown']),
    occurredAt: z.iso.datetime({ offset: true }),
  }),
])

const candidatePageSchema = z.object({
  issues: z.array(
    z.object({
      bindingId: z.string().min(1).max(256).transform(trackerBindingId),
      issueId: z.string().min(1).max(256).transform(trackerIssueId),
      displayKey: z.string().min(1).max(256),
      summary: z.string(),
      priorityRank: z.number().int().nonnegative(),
      isReady: z.boolean(),
      labels: z.array(z.string()),
      comments: z.array(commentSchema),
      dependencies: z.array(dependencySchema),
      readiness: readinessSchema,
    }),
  ),
  nextCursor: z.string().min(1).max(4096).optional(),
})

interface RegisteredProvider {
  provider: TrackerProvider
  controller: AbortController
  active: Set<Promise<unknown>>
  accepting: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tracker: Tracker
  }
}

/** Provider registry and normalized read seam consumed by admission. */
export class Tracker extends Service {
  private readonly providers = new Map<TrackerProviderId, RegisteredProvider>()

  constructor(ctx: Context) {
    super(ctx, 'tracker')
  }

  /**
   * Register one complete interface-v1 provider until the returned async disposer settles its active operations.
   * Duplicate ids, incompatible versions, and missing capabilities throw synchronously; withdrawal aborts provider reads.
   */
  register(provider: TrackerProvider): () => Promise<void> {
    if (provider.interfaceVersion !== TRACKER_INTERFACE_VERSION) {
      throw new TypeError(
        `tracker provider "${provider.id}" uses interface version ${String(provider.interfaceVersion)}; expected ${String(TRACKER_INTERFACE_VERSION)}`,
      )
    }
    if (this.providers.has(provider.id)) {
      throw new Error(`tracker provider "${provider.id}" is already registered`)
    }
    const missing = trackerCapabilities.filter((capability) => !provider.capabilities.includes(capability))
    if (missing.length > 0) {
      throw new TypeError(`tracker provider "${provider.id}" is missing capabilities: ${missing.join(', ')}`)
    }
    const registered: RegisteredProvider = {
      provider,
      controller: new AbortController(),
      active: new Set(),
      accepting: true,
    }
    this.providers.set(provider.id, registered)

    return async () => {
      if (this.providers.get(provider.id) !== registered) return
      registered.accepting = false
      registered.controller.abort()
      await Promise.allSettled(registered.active)
      if (this.providers.get(provider.id) === registered) this.providers.delete(provider.id)
    }
  }

  /**
   * Read and validate one provider page. Unknown/withdrawn providers and normalized provider failures reject; the
   * provider-owned abort signal is cancelled on withdrawal, while callers have no separate cancellation signal.
   */
  async readCandidates(id: TrackerProviderId, cursor?: string): Promise<TrackerCandidatePage> {
    return this.withProvider(id, (reader) => reader.readCandidates(cursor))
  }

  /**
   * Keep one provider generation alive for a complete consumer operation and expose only its validated reader.
   * Provider reads use the generation's withdrawal signal. Consumer errors propagate unchanged; the returned promise
   * settles before provider disposal can finish, and callers have no independent cancellation signal in version 1.
   */
  async withProvider<T>(id: TrackerProviderId, operation: (reader: TrackerReader) => Promise<T>): Promise<T> {
    const registered = this.providers.get(id)
    if (registered === undefined || !registered.accepting) {
      throw new TrackerProviderError('provider-unavailable', `tracker provider "${id}" is unavailable`)
    }
    const reader: TrackerReader = {
      readCandidates: (cursor) => this.readProviderCandidates(registered, cursor),
    }
    let active: Promise<T>
    try {
      active = Promise.resolve(operation(reader))
    } catch (error) {
      active = Promise.reject(error)
    }
    registered.active.add(active)
    try {
      return await active
    } finally {
      registered.active.delete(active)
    }
  }

  private async readProviderCandidates(registered: RegisteredProvider, cursor?: string): Promise<TrackerCandidatePage> {
    const request: TrackerReadRequest = {
      signal: registered.controller.signal,
      ...(cursor === undefined ? {} : { cursor }),
    }
    let page: TrackerCandidatePage
    try {
      page = await registered.provider.readCandidates(request)
    } catch (error) {
      if (!registered.accepting) {
        throw new TrackerProviderError(
          'provider-unavailable',
          `tracker provider "${registered.provider.id}" was withdrawn`,
        )
      }
      if (error instanceof TrackerProviderError) throw error
      throw new TrackerProviderError(
        'transient',
        `tracker provider "${registered.provider.id}" failed to read candidates`,
      )
    }
    if (!registered.accepting) {
      throw new TrackerProviderError(
        'provider-unavailable',
        `tracker provider "${registered.provider.id}" was withdrawn`,
      )
    }
    const parsed = candidatePageSchema.safeParse(page)
    if (!parsed.success) {
      throw new TrackerProviderError(
        'invalid-response',
        `tracker provider "${registered.provider.id}" returned an invalid candidate page`,
      )
    }
    return {
      issues: parsed.data.issues,
      ...(parsed.data.nextCursor === undefined ? {} : { nextCursor: parsed.data.nextCursor }),
    }
  }
}

export default Tracker
