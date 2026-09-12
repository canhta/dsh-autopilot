declare const codeHostProviderIdBrand: unique symbol
declare const codeHostBindingIdBrand: unique symbol
declare const codeHostRepositoryIdBrand: unique symbol
declare const pullRequestIdBrand: unique symbol

export type CodeHostProviderId = string & { readonly [codeHostProviderIdBrand]: true }
export type CodeHostBindingId = string & { readonly [codeHostBindingIdBrand]: true }
export type CodeHostRepositoryId = string & { readonly [codeHostRepositoryIdBrand]: true }
export type PullRequestId = string & { readonly [pullRequestIdBrand]: true }

const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,255}$/

function opaqueId<T extends string>(kind: string, value: string): T {
  if (!ID_PATTERN.test(value)) throw new TypeError(`${kind} must match ${String(ID_PATTERN)}`)
  return value as T
}

export const codeHostProviderId = (value: string): CodeHostProviderId =>
  opaqueId<CodeHostProviderId>('code-host provider id', value)
export const codeHostBindingId = (value: string): CodeHostBindingId =>
  opaqueId<CodeHostBindingId>('code-host binding id', value)
export const codeHostRepositoryId = (value: string): CodeHostRepositoryId =>
  opaqueId<CodeHostRepositoryId>('code-host repository id', value)
export const pullRequestId = (value: string): PullRequestId => opaqueId<PullRequestId>('pull-request id', value)

export const CODE_HOST_INTERFACE_VERSION = 1 as const
export const codeHostCapabilities = ['repository', 'branch', 'pull-request', 'reconciliation'] as const
export type CodeHostCapability = (typeof codeHostCapabilities)[number]

/** Provider-owned publication target selected before a run allocates execution resources. */
export interface CodeHostBinding {
  readonly providerId: CodeHostProviderId
  readonly bindingId: CodeHostBindingId
  readonly repositoryId: CodeHostRepositoryId
  readonly repository: string
}

export interface CodeHostTreeEntry {
  readonly path: string
  readonly mode: '100644' | '100755'
  readonly type: 'blob'
  readonly sha: string
}

export interface CodeHostFile {
  readonly path: string
  readonly content: string
}

/** Complete bounded publication input, reconstructed from the durable intent and verified local Git state. */
export interface CodeHostPublication {
  readonly bindingId: CodeHostBindingId
  readonly repositoryId: CodeHostRepositoryId
  readonly repository: string
  readonly baseBranch: string
  readonly headBranch: string
  readonly baseHead: string
  readonly localHead: string
  readonly tree: readonly CodeHostTreeEntry[]
  readonly files: readonly CodeHostFile[]
  readonly title: string
  readonly body: string
  readonly marker: string
}

export interface PullRequestReceipt {
  readonly id: PullRequestId
  readonly number: number
  readonly url: string
  readonly state: 'open' | 'merged' | 'closed-unmerged'
  readonly baseBranch: string
  readonly headBranch: string
  readonly remoteHead: string
}

export type CodeHostBranchObservation =
  | { readonly kind: 'missing' }
  | { readonly kind: 'base'; readonly remoteHead: string }
  | { readonly kind: 'published'; readonly remoteHead: string }
  | { readonly kind: 'conflict'; readonly remoteHead: string }

export type CodeHostPullRequestObservation =
  | { readonly kind: 'missing' }
  | { readonly kind: 'matching'; readonly receipt: PullRequestReceipt }
  | { readonly kind: 'conflict'; readonly reason: string }

export interface CodeHostReconciliation {
  readonly baseHead: string
  readonly branch: CodeHostBranchObservation
  readonly pullRequest: CodeHostPullRequestObservation
}

export interface CodeHostProviderRequest {
  readonly publication: CodeHostPublication
  readonly signal: AbortSignal
}

export interface CodeHostProvider {
  readonly id: CodeHostProviderId
  readonly interfaceVersion: typeof CODE_HOST_INTERFACE_VERSION
  readonly displayName: string
  readonly configurationNamespace: string
  readonly capabilities: readonly CodeHostCapability[]
  reconcile(request: CodeHostProviderRequest): Promise<CodeHostReconciliation>
  createBranch(request: CodeHostProviderRequest): Promise<void>
  publishChanges(request: CodeHostProviderRequest): Promise<void>
  createPullRequest(request: CodeHostProviderRequest): Promise<PullRequestReceipt>
}

export interface CodeHostPublisher {
  reconcile(publication: CodeHostPublication, signal?: AbortSignal): Promise<CodeHostReconciliation>
  createBranch(publication: CodeHostPublication, signal?: AbortSignal): Promise<void>
  publishChanges(publication: CodeHostPublication, signal?: AbortSignal): Promise<void>
  createPullRequest(publication: CodeHostPublication, signal?: AbortSignal): Promise<PullRequestReceipt>
}

export type CodeHostProviderErrorCode =
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

export class CodeHostProviderError extends Error {
  constructor(
    readonly code: CodeHostProviderErrorCode,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'CodeHostProviderError'
  }
}
