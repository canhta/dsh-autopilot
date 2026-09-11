import type { Context } from '@deepseek-ai/cordis'
import { createMcpTraversalCursorCodec, type McpReadTools, mountMcpTracker } from '../../mcp/index.js'
import {
  TRACKER_INTERFACE_VERSION,
  type TrackerIssueSnapshot,
  type TrackerProvider,
  TrackerProviderError,
  trackerProviderId,
} from '../../tracker.js'
import { type GitHubCoordinate, githubMcpContracts } from './contracts.js'
import { verifyGitHubIssuesIngress } from './ingress.js'
import { normalizeIssue } from './normalization.js'
import type { GitHubComment, GitHubDependency, GitHubIssue, GitHubTimelineEvent } from './schemas.js'
import {
  type GitHubIssuesSettings,
  githubIssuesSettingsSchema,
  requireConfiguredSettings,
  validateStoredSettings,
} from './settings.js'

const githubIssuesProviderId = trackerProviderId('github-issues')

export const name = 'dsh-autopilot-github-issues'
export const inject = ['tracker', 'settings', 'credentials', 'tools']

/** Register GitHub Settings and mount a provider only while its exact MCP capabilities are available. */
export async function registerGitHubIssuesProvider(ctx: Context): Promise<() => Promise<void>> {
  const settings = ctx.settings.register('dsh-autopilot-github-issues', githubIssuesSettingsSchema, {
    validate: validateStoredSettings,
  })
  return mountMcpTracker(ctx, {
    settings,
    requiredToolset(current) {
      return { serverName: current.mcpServerName, contracts: githubMcpContracts }
    },
    createProvider: (current, tools) => createGitHubIssuesProvider(ctx, current, tools),
  })
}

export async function apply(ctx: Context): Promise<void> {
  await ctx.effect(() => registerGitHubIssuesProvider(ctx), 'dsh-autopilot-github-issues.mcp')
}

function createGitHubIssuesProvider(
  ctx: Context,
  snapshot: Readonly<GitHubIssuesSettings>,
  tools: McpReadTools<typeof githubMcpContracts>,
): TrackerProvider {
  const config = requireConfiguredSettings(snapshot)
  const cursorCodec = createMcpTraversalCursorCodec()
  return {
    id: githubIssuesProviderId,
    interfaceVersion: TRACKER_INTERFACE_VERSION,
    displayName: 'GitHub Issues via official MCP',
    configurationNamespace: 'dsh-autopilot-github-issues',
    capabilities: ['candidates', 'comments', 'dependencies', 'readiness', 'ingress'],
    async readCandidates({ cursor, signal }) {
      const identity = await tools.call('readIdentity', {}, signal)
      if (String(identity.id) !== config.integrationActorId) {
        throw new TrackerProviderError(
          'provider-unavailable',
          'GitHub MCP identity does not match the configured integration actor',
        )
      }
      const state = cursor === undefined ? { pagesRead: 0, itemsRead: 0 } : cursorCodec.decode(cursor)
      const page = await tools.call(
        'listCandidates',
        {
          owner: config.repositoryOwner,
          repo: config.repositoryName,
          label: config.readyLabel,
          pageSize: config.pageSize,
          ...('vendorCursor' in state ? { after: state.vendorCursor } : {}),
        },
        signal,
      )
      const pagesRead = state.pagesRead + 1
      const itemsRead = state.itemsRead + page.issues.length
      assertTraversalBounds(pagesRead, itemsRead, config)
      const issues: TrackerIssueSnapshot[] = []
      const seen = new Set<number>()
      for (const issue of stableIssues(page.issues)) {
        if (seen.has(issue.number)) continue
        seen.add(issue.number)
        issues.push(await hydrateIssue(issue, config, tools, signal))
      }
      const after = nextCursor(page.pageInfo)
      if (after !== undefined) {
        if ('vendorCursor' in state && after === state.vendorCursor) throw paginationAdvance('candidates')
        if (pagesRead >= config.maxPagesPerTraversal || itemsRead >= config.maxItemsPerTraversal) {
          throw paginationBound('candidates')
        }
      }
      return {
        issues,
        ...(after === undefined
          ? {}
          : { nextCursor: cursorCodec.encode({ vendorCursor: after, pagesRead, itemsRead }) }),
      }
    },
    verifyIngress: (request) => verifyGitHubIssuesIngress(ctx, config, request),
  }
}

async function hydrateIssue(
  issue: GitHubIssue,
  config: GitHubIssuesSettings,
  tools: McpReadTools<typeof githubMcpContracts>,
  signal: AbortSignal,
): Promise<TrackerIssueSnapshot> {
  const coordinate = {
    owner: config.repositoryOwner,
    repo: config.repositoryName,
    issueNumber: issue.number,
  }
  const comments = await readComments(coordinate, config, tools, signal)
  const timeline = await readTimeline(coordinate, config, tools, signal)
  const dependencies = await readDependencies(coordinate, config, tools, signal)
  const completeDependencies = []
  for (const dependency of dependencies) {
    if (dependency.state === 'OPEN') {
      completeDependencies.push(dependency)
      continue
    }
    const { owner, repo } = dependencyRepository(dependency.repository)
    const detail = await tools.call('readIssue', { owner, repo, issueNumber: dependency.number }, signal)
    if (detail.number !== dependency.number || detail.state !== 'closed') {
      throw new TrackerProviderError('invalid-response', 'GitHub Issues dependency detail did not match')
    }
    completeDependencies.push({
      ...dependency,
      ...(detail.state_reason === undefined ? {} : { stateReason: detail.state_reason }),
    })
  }
  return normalizeIssue(issue, { comments, dependencies: completeDependencies, timeline }, config)
}

async function readComments(
  coordinate: GitHubCoordinate,
  config: GitHubIssuesSettings,
  tools: McpReadTools<typeof githubMcpContracts>,
  signal: AbortSignal,
): Promise<GitHubComment[]> {
  const comments: GitHubComment[] = []
  for (let page = 1; page <= config.maxPagesPerTraversal; page += 1) {
    const next = await tools.call('readComments', { ...coordinate, page, pageSize: config.pageSize }, signal)
    comments.push(...next)
    assertItemBound(comments.length, config)
    if (next.length < config.pageSize) return comments
  }
  throw paginationBound('comments')
}

async function readTimeline(
  coordinate: GitHubCoordinate,
  config: GitHubIssuesSettings,
  tools: McpReadTools<typeof githubMcpContracts>,
  signal: AbortSignal,
): Promise<GitHubTimelineEvent[]> {
  const events: GitHubTimelineEvent[] = []
  let page = 1
  for (let count = 0; count < config.maxPagesPerTraversal; count += 1) {
    const next = await tools.call('readReadinessHistory', { ...coordinate, page, pageSize: config.pageSize }, signal)
    events.push(...next.events)
    assertItemBound(events.length, config)
    if (!next.pageInfo.hasNextPage) return events
    if (next.pageInfo.nextPage === undefined || next.pageInfo.nextPage <= page) throw paginationAdvance('timeline')
    page = next.pageInfo.nextPage
  }
  throw paginationBound('timeline')
}

async function readDependencies(
  coordinate: GitHubCoordinate,
  config: GitHubIssuesSettings,
  tools: McpReadTools<typeof githubMcpContracts>,
  signal: AbortSignal,
): Promise<GitHubDependency[]> {
  const dependencies: GitHubDependency[] = []
  let page = 1
  for (let count = 0; count < config.maxPagesPerTraversal; count += 1) {
    const next = await tools.call('readDependencies', { ...coordinate, page, pageSize: config.pageSize }, signal)
    dependencies.push(...next.issues)
    assertItemBound(dependencies.length, config)
    if (!next.pageInfo.hasNextPage) return dependencies
    if (next.pageInfo.nextPage === undefined || next.pageInfo.nextPage <= page) throw paginationAdvance('dependencies')
    page = next.pageInfo.nextPage
  }
  throw paginationBound('dependencies')
}

function nextCursor(pageInfo: { hasNextPage: boolean; endCursor?: string | undefined }): string | undefined {
  if (!pageInfo.hasNextPage) return undefined
  if (pageInfo.endCursor === undefined) throw paginationAdvance('candidates')
  return pageInfo.endCursor
}

function assertTraversalBounds(pages: number, items: number, config: GitHubIssuesSettings): void {
  if (pages > config.maxPagesPerTraversal || items > config.maxItemsPerTraversal) throw paginationBound('candidates')
}

function assertItemBound(items: number, config: GitHubIssuesSettings): void {
  if (items > config.maxItemsPerTraversal) throw paginationBound('nested evidence')
}

function paginationAdvance(subject: string): TrackerProviderError {
  return new TrackerProviderError('invalid-response', `GitHub Issues ${subject} pagination did not advance`)
}

function paginationBound(subject: string): TrackerProviderError {
  return new TrackerProviderError('invalid-response', `GitHub Issues ${subject} exceeded its safety bound`)
}

function dependencyRepository(value: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = value.split('/')
  if (rest.length > 0 || owner === undefined || repo === undefined || owner === '' || repo === '') {
    throw new TrackerProviderError('invalid-response', 'GitHub Issues dependency repository was malformed')
  }
  return { owner, repo }
}

function stableIssues(issues: readonly GitHubIssue[]): GitHubIssue[] {
  return [...issues].sort((left, right) => {
    const leftTime = timestamp(left.created_at)
    const rightTime = timestamp(right.created_at)
    return leftTime === rightTime ? left.number - right.number : leftTime - rightTime
  })
}

function timestamp(value: string): number {
  const time = Date.parse(value)
  if (Number.isNaN(time))
    throw new TrackerProviderError('invalid-response', 'GitHub Issues returned an invalid timestamp')
  return time
}
