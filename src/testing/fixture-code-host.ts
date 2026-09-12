import {
  CODE_HOST_INTERFACE_VERSION,
  type CodeHostProvider,
  type CodeHostPublication,
  type CodeHostReconciliation,
  codeHostProviderId,
  type PullRequestReceipt,
  pullRequestId,
} from '../code-host.js'

export interface FixtureCodeHostState {
  baseHead: string
  branch?: { remoteHead: string; publication: CodeHostPublication }
  pullRequest?: PullRequestReceipt
}

export interface FixtureCodeHostProviderOptions extends Partial<CodeHostProvider> {
  state: FixtureCodeHostState
}

/** Deterministic mutable code-host fixture used by conformance, crash-recovery, and paired-provider tests. */
export function createFixtureCodeHostProvider(options: FixtureCodeHostProviderOptions): CodeHostProvider {
  const { state, ...overrides } = options
  return {
    id: codeHostProviderId('fixture-code-host'),
    interfaceVersion: CODE_HOST_INTERFACE_VERSION,
    displayName: 'Fixture code host',
    configurationNamespace: 'fixture-code-host',
    capabilities: ['repository', 'branch', 'pull-request', 'reconciliation'],
    reconcile({ publication }) {
      return Promise.resolve(reconcileFixture(state, publication))
    },
    createBranch({ publication }) {
      if (state.branch !== undefined) throw new Error('fixture branch already exists')
      state.branch = { remoteHead: state.baseHead, publication: structuredClone(publication) }
      return Promise.resolve()
    },
    publishChanges({ publication }) {
      if (state.branch?.remoteHead !== state.baseHead)
        throw new Error('fixture branch is not based on the intended base')
      state.branch = { remoteHead: publication.localHead, publication: structuredClone(publication) }
      return Promise.resolve()
    },
    createPullRequest({ publication }) {
      if (state.pullRequest !== undefined) throw new Error('fixture pull request already exists')
      if (state.branch?.remoteHead !== publication.localHead) throw new Error('fixture branch is not published')
      const receipt: PullRequestReceipt = {
        id: pullRequestId('fixture-pr:1'),
        number: 1,
        url: 'https://code-host.example.invalid/pulls/1',
        state: 'open',
        baseBranch: publication.baseBranch,
        headBranch: publication.headBranch,
        remoteHead: state.branch.remoteHead,
      }
      state.pullRequest = receipt
      return Promise.resolve(receipt)
    },
    ...overrides,
  }
}

function reconcileFixture(state: FixtureCodeHostState, publication: CodeHostPublication): CodeHostReconciliation {
  const branch =
    state.branch === undefined
      ? ({ kind: 'missing' } as const)
      : state.branch.remoteHead === state.baseHead
        ? ({ kind: 'base', remoteHead: state.branch.remoteHead } as const)
        : state.branch.remoteHead === publication.localHead
          ? ({ kind: 'published', remoteHead: state.branch.remoteHead } as const)
          : ({ kind: 'conflict', remoteHead: state.branch.remoteHead } as const)
  const pullRequest =
    state.pullRequest === undefined
      ? ({ kind: 'missing' } as const)
      : state.pullRequest.baseBranch === publication.baseBranch &&
          state.pullRequest.headBranch === publication.headBranch &&
          state.pullRequest.remoteHead === state.branch?.remoteHead
        ? ({ kind: 'matching', receipt: structuredClone(state.pullRequest) } as const)
        : ({ kind: 'conflict', reason: 'fixture pull request does not match the publication identity' } as const)
  return { baseHead: state.baseHead, branch, pullRequest }
}
