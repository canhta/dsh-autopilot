import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import {
  CODE_HOST_INTERFACE_VERSION,
  type CodeHostProvider,
  CodeHostProviderError,
  type CodeHostPublication,
  type CodeHostReconciliation,
  codeHostBindingId,
  codeHostProviderId,
  codeHostRepositoryId,
  type PullRequestReceipt,
  pullRequestId,
} from '../../code-host.js'
import { type McpTools, type ResolvedMcpTools, resolveMcpTools } from '../../mcp/index.js'
import { githubCodeHostMcpContracts } from './contracts.js'
import type { GitHubPullRequest } from './schemas.js'
import {
  changesGitHubCodeHostBinding,
  type GitHubCodeHostSettings,
  githubCodeHostSettingsSchema,
  requireConfiguredSettings,
  validateStoredSettings,
} from './settings.js'

const providerId = codeHostProviderId('github')

export const name = 'dsh-autopilot-github-code-host'
export const inject = ['codeHost', 'settings', 'tools']

export async function registerGitHubCodeHostProvider(ctx: Context): Promise<() => Promise<void>> {
  let settings: SettingsScope<GitHubCodeHostSettings> | undefined
  settings = ctx.settings.register('dsh-autopilot-github-code-host', githubCodeHostSettingsSchema, {
    validate: (value) => {
      validateStoredSettings(value)
      const current = settings?.get()
      if (!current || !changesGitHubCodeHostBinding(current, value)) return
      const admission = ctx.get('admission')
      if (admission === undefined) {
        throw new Error('Admission is unavailable; GitHub code-host binding changes are disabled')
      }
      const blocker = admission.codeHostBindingSwitchBlocker(String(providerId))
      if (blocker !== undefined) throw new Error(blocker)
    },
  })
  const registeredSettings = settings
  let active:
    | {
        settings: Readonly<GitHubCodeHostSettings>
        resolved: ResolvedMcpTools<typeof githubCodeHostMcpContracts>
        dispose: () => Promise<void>
      }
    | undefined
  let activeBinding:
    | {
        bindingId: string
        repositoryId: string
        repository: string
        dispose: () => void
      }
    | undefined
  let revision = 0
  let stopped = false
  let queue = Promise.resolve()

  const withdrawProvider = async (): Promise<void> => {
    const current = active
    active = undefined
    if (current !== undefined) await current.dispose()
  }
  const withdraw = async (): Promise<void> => {
    await withdrawProvider()
    activeBinding?.dispose()
    activeBinding = undefined
  }
  const reconcile = async (requestedRevision: number): Promise<void> => {
    if (stopped) return
    let snapshot: Readonly<GitHubCodeHostSettings>
    let resolved: ResolvedMcpTools<typeof githubCodeHostMcpContracts> | undefined
    try {
      snapshot = structuredClone(registeredSettings.get())
      requireConfiguredSettings(snapshot)
      resolved = resolveMcpTools(
        ctx,
        snapshot.mcpServerName,
        githubCodeHostMcpContracts,
        (code, message) => new CodeHostProviderError(code, message),
      )
    } catch {
      await withdraw()
      ctx.logger.warn('autopilot GitHub code-host configuration is invalid; provider remains unavailable')
      return
    }
    const repository = `${snapshot.repositoryOwner}/${snapshot.repositoryName}`
    if (
      activeBinding === undefined ||
      activeBinding.bindingId !== snapshot.bindingId ||
      activeBinding.repositoryId !== snapshot.repositoryId ||
      activeBinding.repository !== repository
    ) {
      await withdrawProvider()
      activeBinding?.dispose()
      activeBinding = undefined
      if (stopped || requestedRevision !== revision) return
      const dispose = ctx.codeHost.registerBinding({
        providerId,
        bindingId: codeHostBindingId(snapshot.bindingId),
        repositoryId: codeHostRepositoryId(snapshot.repositoryId),
        repository,
      })
      activeBinding = { bindingId: snapshot.bindingId, repositoryId: snapshot.repositoryId, repository, dispose }
    }
    if (
      resolved !== undefined &&
      active !== undefined &&
      isDeepStrictEqual(active.settings, snapshot) &&
      active.resolved.sameDefinitions(resolved)
    ) {
      return
    }
    await withdrawProvider()
    if (stopped || requestedRevision !== revision || resolved === undefined || !resolved.isCurrent()) return
    const dispose = ctx.codeHost.register(createProvider(snapshot, resolved.tools))
    if (stopped || requestedRevision !== revision || !resolved.isCurrent()) {
      await dispose()
      return
    }
    active = { settings: snapshot, resolved, dispose }
  }
  const schedule = (): Promise<void> => {
    const requestedRevision = ++revision
    queue = queue
      .then(() => reconcile(requestedRevision))
      .catch(() => {
        ctx.logger.warn('autopilot GitHub code-host reconciliation failed; provider remains unavailable')
      })
    return queue
  }
  const stopSettings = registeredSettings.watch(() => schedule())
  const stopTools = ctx.on('tools/change', () => void schedule())
  await schedule()
  return async () => {
    if (stopped) return
    stopped = true
    revision += 1
    stopSettings()
    stopTools()
    await queue
    await withdraw()
  }
}

export async function apply(ctx: Context): Promise<void> {
  await ctx.effect(() => registerGitHubCodeHostProvider(ctx), 'dsh-autopilot-github-code-host.mcp')
}

function createProvider(
  snapshot: Readonly<GitHubCodeHostSettings>,
  tools: McpTools<typeof githubCodeHostMcpContracts>,
): CodeHostProvider {
  const config = requireConfiguredSettings(snapshot)
  return {
    id: providerId,
    interfaceVersion: CODE_HOST_INTERFACE_VERSION,
    displayName: 'GitHub via official MCP',
    configurationNamespace: 'dsh-autopilot-github-code-host',
    capabilities: ['repository', 'branch', 'pull-request', 'reconciliation'],
    async reconcile({ publication, signal }) {
      validatePublication(publication, config)
      await assertIdentity(config, tools, signal)
      return await reconcile(publication, config, tools, signal)
    },
    async createBranch({ publication, signal }) {
      validatePublication(publication, config)
      await assertIdentity(config, tools, signal)
      await mutation(async () => {
        const result = await tools.call(
          'createBranch',
          {
            owner: config.repositoryOwner,
            repo: config.repositoryName,
            branch: publication.headBranch,
            base: publication.baseBranch,
          },
          signal,
        )
        if (result.object.sha !== publication.baseHead || result.ref !== `refs/heads/${publication.headBranch}`) {
          throw new CodeHostProviderError('invalid-response', 'GitHub created a branch with an unexpected identity')
        }
      })
    },
    async publishChanges({ publication, signal }) {
      validatePublication(publication, config)
      await assertIdentity(config, tools, signal)
      await mutation(() =>
        tools.call(
          'pushFiles',
          {
            owner: config.repositoryOwner,
            repo: config.repositoryName,
            branch: publication.headBranch,
            files: publication.files,
            message: `dsh-autopilot: publish ${publication.marker.replaceAll(/[^a-zA-Z0-9:_-]/g, '')}`,
          },
          signal,
        ),
      )
    },
    async createPullRequest({ publication, signal }) {
      validatePublication(publication, config)
      await assertIdentity(config, tools, signal)
      let created = false
      return await mutation(
        async () => {
          const response = await tools.call(
            'createPullRequest',
            {
              owner: config.repositoryOwner,
              repo: config.repositoryName,
              title: publication.title,
              head: publication.headBranch,
              base: publication.baseBranch,
              body: publication.body,
            },
            signal,
          )
          created = true
          const detail = await tools.call(
            'readPullRequest',
            {
              owner: config.repositoryOwner,
              repo: config.repositoryName,
              pullNumber: response.number,
            },
            signal,
          )
          return receipt(detail)
        },
        () => created,
      )
    },
  }
}

async function reconcile(
  publication: CodeHostPublication,
  config: GitHubCodeHostSettings,
  tools: McpTools<typeof githubCodeHostMcpContracts>,
  signal: AbortSignal,
): Promise<CodeHostReconciliation> {
  const base = await tools.call(
    'readCommit',
    { owner: config.repositoryOwner, repo: config.repositoryName, sha: publication.baseBranch },
    signal,
  )
  const branches = await readAllBranches(config, tools, signal)
  const branch = branches.find((candidate) => candidate.name === publication.headBranch)
  let branchObservation: CodeHostReconciliation['branch'] = { kind: 'missing' }
  if (branch !== undefined) {
    if (branch.sha === base.sha) branchObservation = { kind: 'base', remoteHead: branch.sha }
    else {
      const remoteTree = await tools.call(
        'readTree',
        { owner: config.repositoryOwner, repo: config.repositoryName, ref: publication.headBranch },
        signal,
      )
      if (remoteTree.truncated)
        throw new CodeHostProviderError('invalid-response', 'GitHub repository tree was truncated')
      const normalized = remoteTree.tree
        .filter((entry) => entry.type === 'blob')
        .map((entry) => ({ path: entry.path, mode: entry.mode, type: entry.type, sha: entry.sha }))
        .sort((left, right) => left.path.localeCompare(right.path))
      const expected = [...publication.tree].sort((left, right) => left.path.localeCompare(right.path))
      branchObservation = isDeepStrictEqual(normalized, expected)
        ? { kind: 'published', remoteHead: branch.sha }
        : { kind: 'conflict', remoteHead: branch.sha }
    }
  }
  const prs = await readAllPullRequests(publication, config, tools, signal)
  const pullRequest = reconcilePullRequests(prs, publication)
  return { baseHead: base.sha, branch: branchObservation, pullRequest }
}

async function readAllBranches(
  config: GitHubCodeHostSettings,
  tools: McpTools<typeof githubCodeHostMcpContracts>,
  signal: AbortSignal,
) {
  const branches = []
  for (let page = 1; page <= config.maxPagesPerTraversal; page += 1) {
    const next = await tools.call(
      'listBranches',
      { owner: config.repositoryOwner, repo: config.repositoryName, page, pageSize: config.pageSize },
      signal,
    )
    branches.push(...next)
    if (next.length < config.pageSize) return branches
  }
  throw new CodeHostProviderError('invalid-response', 'GitHub branch pagination exceeded its safety bound')
}

async function readAllPullRequests(
  publication: CodeHostPublication,
  config: GitHubCodeHostSettings,
  tools: McpTools<typeof githubCodeHostMcpContracts>,
  signal: AbortSignal,
): Promise<GitHubPullRequest[]> {
  const pullRequests = []
  for (let page = 1; page <= config.maxPagesPerTraversal; page += 1) {
    const next = await tools.call(
      'listPullRequests',
      {
        owner: config.repositoryOwner,
        repo: config.repositoryName,
        head: `${config.repositoryOwner}:${publication.headBranch}`,
        base: publication.baseBranch,
        page,
        pageSize: config.pageSize,
      },
      signal,
    )
    pullRequests.push(...next)
    if (next.length < config.pageSize) return pullRequests
  }
  throw new CodeHostProviderError('invalid-response', 'GitHub pull-request pagination exceeded its safety bound')
}

function reconcilePullRequests(
  pullRequests: readonly GitHubPullRequest[],
  publication: CodeHostPublication,
): CodeHostReconciliation['pullRequest'] {
  if (pullRequests.length === 0) return { kind: 'missing' }
  if (pullRequests.length !== 1)
    return { kind: 'conflict', reason: 'multiple pull requests use the deterministic head' }
  const pr = pullRequests[0]
  if (
    pr === undefined ||
    !pr.body.includes(publication.marker) ||
    pr.base.ref !== publication.baseBranch ||
    pr.head.ref !== publication.headBranch ||
    pr.draft
  ) {
    return { kind: 'conflict', reason: 'existing pull request does not match the ready publication identity' }
  }
  return { kind: 'matching', receipt: receipt(pr) }
}

function receipt(pr: GitHubPullRequest): PullRequestReceipt {
  return {
    id: pullRequestId(`github:${String(pr.number)}`),
    number: pr.number,
    url: pr.html_url,
    state: pr.merged ? 'merged' : pr.state === 'open' ? 'open' : 'closed-unmerged',
    baseBranch: pr.base.ref,
    headBranch: pr.head.ref,
    remoteHead: pr.head.sha,
  }
}

async function assertIdentity(
  config: GitHubCodeHostSettings,
  tools: McpTools<typeof githubCodeHostMcpContracts>,
  signal: AbortSignal,
): Promise<void> {
  const identity = await tools.call('readIdentity', {}, signal)
  if (String(identity.id) !== config.integrationActorId) {
    throw new CodeHostProviderError(
      'provider-unavailable',
      'GitHub MCP identity does not match configured publication actor',
    )
  }
}

function validatePublication(publication: CodeHostPublication, config: GitHubCodeHostSettings): void {
  if (
    publication.bindingId !== config.bindingId ||
    publication.repositoryId !== config.repositoryId ||
    publication.repository !== `${config.repositoryOwner}/${config.repositoryName}`
  ) {
    throw new CodeHostProviderError(
      'invalid-configuration',
      'GitHub publication target does not match provider binding',
    )
  }
  if (!publication.body.includes(publication.marker)) {
    throw new CodeHostProviderError('invalid-configuration', 'GitHub pull-request body omitted its stable run marker')
  }
}

async function mutation<T>(operation: () => Promise<T>, acknowledged: () => boolean = () => false): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (
      acknowledged() ||
      (error instanceof CodeHostProviderError &&
        ['invalid-response', 'provider-unavailable', 'timeout', 'transient'].includes(error.code))
    ) {
      throw new CodeHostProviderError('ambiguous-acknowledgement', 'GitHub mutation acknowledgement was ambiguous')
    }
    throw error
  }
}
