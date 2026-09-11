import type { Context } from '@deepseek-ai/cordis'
import { createMcpTraversalCursorCodec, type McpReadTools, mountMcpTracker } from '../../mcp/index.js'
import {
  TRACKER_INTERFACE_VERSION,
  type TrackerProvider,
  TrackerProviderError,
  trackerProviderId,
} from '../../tracker.js'
import { jiraMcpContracts } from './contracts.js'
import { verifyJiraIngress } from './ingress.js'
import { normalizeIssue } from './normalization.js'
import type { JiraChangelog, JiraComment, JiraIssue } from './schemas.js'
import { type JiraSettings, jiraSettingsSchema, requireConfiguredSettings, validateStoredSettings } from './settings.js'

const jiraProviderId = trackerProviderId('jira')

export const name = 'dsh-autopilot-jira'
export const inject = ['tracker', 'settings', 'credentials', 'tools']

/** Register Jira Settings and mount a provider only while the required Atlassian MCP tools conform. */
export async function registerJiraProvider(ctx: Context): Promise<() => Promise<void>> {
  const settings = ctx.settings.register('dsh-autopilot-jira', jiraSettingsSchema, {
    validate: validateStoredSettings,
  })
  return mountMcpTracker(ctx, {
    settings,
    requiredToolset: (current) => ({ serverName: current.mcpServerName, contracts: jiraMcpContracts }),
    createProvider: (current, tools) => createJiraProvider(ctx, current, tools),
  })
}

export async function apply(ctx: Context): Promise<void> {
  await ctx.effect(() => registerJiraProvider(ctx), 'dsh-autopilot-jira.mcp')
}

function createJiraProvider(
  ctx: Context,
  snapshot: Readonly<JiraSettings>,
  tools: McpReadTools<typeof jiraMcpContracts>,
): TrackerProvider {
  const config = requireConfiguredSettings(snapshot)
  const cursorCodec = createMcpTraversalCursorCodec()
  return {
    id: jiraProviderId,
    interfaceVersion: TRACKER_INTERFACE_VERSION,
    displayName: 'Jira Cloud via Atlassian MCP',
    configurationNamespace: 'dsh-autopilot-jira',
    capabilities: ['candidates', 'comments', 'dependencies', 'readiness', 'ingress'],
    async readCandidates({ cursor, signal }) {
      const identity = await tools.call('readIdentity', {}, signal)
      if (identity.account_id !== config.integrationAccountId) {
        throw new TrackerProviderError(
          'provider-unavailable',
          'Jira MCP identity does not match the configured integration account',
        )
      }
      const state = cursor === undefined ? { pagesRead: 0, itemsRead: 0 } : cursorCodec.decode(cursor)
      const page = await tools.call(
        'searchCandidates',
        {
          cloudId: config.cloudId,
          jql: candidateJql(config),
          pageSize: config.pageSize,
          ...('vendorCursor' in state ? { nextPageToken: state.vendorCursor } : {}),
        },
        signal,
      )
      const pagesRead = state.pagesRead + 1
      const itemsRead = state.itemsRead + page.issues.length
      assertTraversalBounds(pagesRead, itemsRead, config)
      const issues = []
      for (const issue of page.issues) {
        if (issue.fields.project.id !== config.projectId) {
          throw new TrackerProviderError('invalid-response', 'Jira candidate project did not match the binding')
        }
        const comments = await readComments(issue, config, tools, signal)
        const changelogs = await readChangelogs(issue, config, tools, signal)
        issues.push(normalizeIssue(issue, config, comments, changelogs))
      }
      if (page.nextPageToken !== undefined) {
        if ('vendorCursor' in state && page.nextPageToken === state.vendorCursor) {
          throw paginationAdvance('candidates')
        }
        if (pagesRead >= config.maxPagesPerTraversal || itemsRead >= config.maxItemsPerTraversal) {
          throw paginationBound('candidates')
        }
      }
      return {
        issues,
        ...(page.nextPageToken === undefined
          ? {}
          : {
              nextCursor: cursorCodec.encode({ vendorCursor: page.nextPageToken, pagesRead, itemsRead }),
            }),
      }
    },
    verifyIngress: (request) => verifyJiraIngress(ctx, config, request),
  }
}

async function readComments(
  issue: JiraIssue,
  config: JiraSettings,
  tools: McpReadTools<typeof jiraMcpContracts>,
  signal: AbortSignal,
): Promise<JiraComment[]> {
  const comments: JiraComment[] = []
  let startAt = 0
  for (let pageCount = 0; pageCount < config.maxPagesPerTraversal; pageCount += 1) {
    const page = await tools.call(
      'readComments',
      { cloudId: config.cloudId, issueKey: issue.key, startAt, pageSize: config.pageSize },
      signal,
    )
    if (page.startAt !== startAt || page.total < startAt) throw paginationAdvance('comments')
    comments.push(...page.comments)
    assertItemBound(comments.length, config, 'comments')
    const next = page.startAt + page.comments.length
    if (next >= page.total) return comments
    if (page.comments.length === 0 || next <= startAt) throw paginationAdvance('comments')
    startAt = next
  }
  throw paginationBound('comments')
}

async function readChangelogs(
  issue: JiraIssue,
  config: JiraSettings,
  tools: McpReadTools<typeof jiraMcpContracts>,
  signal: AbortSignal,
): Promise<JiraChangelog[]> {
  const changelogs: JiraChangelog[] = []
  let startAt = 0
  for (let pageCount = 0; pageCount < config.maxPagesPerTraversal; pageCount += 1) {
    const page = await tools.call(
      'readChangelogs',
      { cloudId: config.cloudId, issueKey: issue.key, startAt, pageSize: config.pageSize },
      signal,
    )
    if (page.startAt !== startAt || page.total < startAt) throw paginationAdvance('changelogs')
    changelogs.push(...page.values)
    assertItemBound(changelogs.length, config, 'changelogs')
    const next = page.startAt + page.values.length
    if (next >= page.total) return changelogs
    if (page.values.length === 0 || next <= startAt) throw paginationAdvance('changelogs')
    startAt = next
  }
  throw paginationBound('changelogs')
}

function candidateJql(config: JiraSettings): string {
  return `project = ${config.projectId} AND labels = "${escapeJql(config.readyLabel)}" ORDER BY created ASC, key ASC`
}

function escapeJql(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function assertTraversalBounds(pages: number, items: number, config: JiraSettings): void {
  if (pages > config.maxPagesPerTraversal || items > config.maxItemsPerTraversal) throw paginationBound('candidates')
}

function assertItemBound(items: number, config: JiraSettings, subject: string): void {
  if (items > config.maxItemsPerTraversal) throw paginationBound(subject)
}

function paginationAdvance(subject: string): TrackerProviderError {
  return new TrackerProviderError('invalid-response', `Jira ${subject} pagination did not advance`)
}

function paginationBound(subject: string): TrackerProviderError {
  return new TrackerProviderError('invalid-response', `Jira ${subject} exceeded its safety bound`)
}
