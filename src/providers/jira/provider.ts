import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { createMcpTraversalCursorCodec, type McpTools, mountMcpTracker } from '../../mcp/index.js'
import {
  TRACKER_INTERFACE_VERSION,
  type TrackerDeliveryObservation,
  type TrackerOutboundDelivery,
  type TrackerOutboundReceipt,
  type TrackerProvider,
  TrackerProviderError,
  trackerProviderId,
} from '../../tracker.js'
import type { ProviderSetupContribution } from '../../web.js'
import { jiraMcpContracts } from './contracts.js'
import { verifyJiraIngress } from './ingress.js'
import { adfToText, jiraBindingId, jiraTimestamp, normalizeIssue, normalizeReadiness } from './normalization.js'
import type { JiraChangelog, JiraComment, JiraIssue, JiraWritableIssue } from './schemas.js'
import {
  changesJiraBinding,
  type JiraSettings,
  jiraSettingsSchema,
  requireConfiguredSettings,
  validateStoredSettings,
} from './settings.js'

const jiraProviderId = trackerProviderId('jira')

export const name = 'dsh-autopilot-jira'
export const inject = ['tracker', 'settings', 'credentials', 'tools']

/** Register Jira Settings and mount a provider only while the required Atlassian MCP tools conform. */
export async function registerJiraProvider(ctx: Context): Promise<() => Promise<void>> {
  let settings: SettingsScope<JiraSettings> | undefined
  settings = ctx.settings.register('dsh-autopilot-jira', jiraSettingsSchema, {
    validate: (value) => {
      validateStoredSettings(value)
      const current = settings?.get()
      if (!current || !changesJiraBinding(current, value)) return
      const admission = ctx.get('admission')
      if (admission === undefined) throw new Error('Admission is unavailable; Jira binding changes are disabled')
      const blocker = admission.trackerSwitchBlocker(String(jiraProviderId))
      if (blocker !== undefined) throw new Error(blocker)
    },
  })
  const registeredSettings = settings
  const setup = ctx.get('autopilotWebContributions')?.registerProvider(jiraSetup(registeredSettings))
  try {
    const unmount = await mountMcpTracker(ctx, {
      settings: registeredSettings,
      requiredToolset: (current) => ({ serverName: current.mcpServerName, contracts: jiraMcpContracts }),
      createProvider: (current, tools) => createJiraProvider(ctx, current, tools),
    })
    return async () => {
      await unmount()
      setup?.()
    }
  } catch (error) {
    setup?.()
    throw error
  }
}

function jiraSetup(settings: { get(): Readonly<JiraSettings> }): ProviderSetupContribution {
  return {
    providerId: 'jira',
    displayName: 'Jira Cloud via Atlassian MCP',
    configurationNamespace: 'dsh-autopilot-jira',
    view() {
      const value = settings.get()
      return {
        status: 'available',
        mcpServerName: value.mcpServerName,
        resources: [
          { label: 'Cloud id', value: value.cloudId },
          { label: 'Project id', value: value.projectId },
          { label: 'Ready label', value: value.readyLabel },
        ],
        credentialRefs:
          value.webhookSecretRef === '' ? [] : [{ label: 'Inbound webhook secret', ref: value.webhookSecretRef }],
        lookup: {
          status: 'unavailable',
          reason: 'DSH does not expose Atlassian MCP project or label lookup to Client plugins at this version.',
        },
      }
    },
  }
}

export async function apply(ctx: Context): Promise<void> {
  await ctx.effect(() => registerJiraProvider(ctx), 'dsh-autopilot-jira.mcp')
}

function createJiraProvider(
  ctx: Context,
  snapshot: Readonly<JiraSettings>,
  tools: McpTools<typeof jiraMcpContracts>,
): TrackerProvider {
  const config = requireConfiguredSettings(snapshot)
  const cursorCodec = createMcpTraversalCursorCodec()
  return {
    id: jiraProviderId,
    interfaceVersion: TRACKER_INTERFACE_VERSION,
    displayName: 'Jira Cloud via Atlassian MCP',
    configurationNamespace: 'dsh-autopilot-jira',
    capabilities: ['candidates', 'comments', 'dependencies', 'readiness', 'ingress', 'reports', 'projections'],
    async readCandidates({ cursor, signal }) {
      await assertIdentity(config, tools, signal)
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
    reconcileDelivery: ({ delivery, signal }) => reconcileDelivery(delivery, config, tools, signal),
    deliver: ({ delivery, signal }) => deliver(delivery, config, tools, signal),
  }
}

async function reconcileDelivery(
  delivery: TrackerOutboundDelivery,
  config: JiraSettings,
  tools: McpTools<typeof jiraMcpContracts>,
  signal: AbortSignal,
): Promise<TrackerDeliveryObservation> {
  assertDeliveryTarget(delivery, config)
  await assertIdentity(config, tools, signal)
  const issue = await readWritableIssue(delivery, config, tools, signal)
  if (delivery.kind === 'report') {
    const comments = await readCommentsForKey(delivery.displayKey, config, tools, signal)
    const marker = reportMarker(delivery.eventId)
    const matching = comments.filter((comment) => adfToText(comment.body).includes(marker))
    if (matching.length > 1) return { kind: 'conflict', reason: 'multiple Jira comments use the delivery marker' }
    const comment = matching[0]
    if (comment !== undefined && comment.author?.accountId !== config.integrationAccountId) {
      return { kind: 'conflict', reason: 'Jira delivery marker was written by another account' }
    }
    return comment === undefined
      ? { kind: 'missing' }
      : {
          kind: 'delivered',
          receipt: {
            receiptId: `jira:comment:${comment.id}`,
            receivedAt: jiraTimestamp(comment.updated, `comment ${comment.id}`),
          },
        }
  }

  await assertCurrentReadiness(delivery, config, tools, signal)
  return projectionMatches(issue, delivery, config)
    ? { kind: 'delivered', receipt: projectionReceipt(delivery, issue) }
    : { kind: 'missing' }
}

async function deliver(
  delivery: TrackerOutboundDelivery,
  config: JiraSettings,
  tools: McpTools<typeof jiraMcpContracts>,
  signal: AbortSignal,
): Promise<TrackerOutboundReceipt> {
  assertDeliveryTarget(delivery, config)
  await assertIdentity(config, tools, signal)
  const issue = await readWritableIssue(delivery, config, tools, signal)
  if (delivery.kind === 'report') {
    const result = await mutation(() =>
      tools.call(
        'writeComment',
        { cloudId: config.cloudId, issueKey: delivery.displayKey, body: delivery.body },
        signal,
      ),
    )
    return { receiptId: `jira:comment:${result.id}`, receivedAt: new Date().toISOString() }
  }

  await assertCurrentReadiness(delivery, config, tools, signal)
  const labels = desiredLabels(issue.fields.labels, delivery.desiredState, config)
  if (!sameLabels(labels, issue.fields.labels)) {
    await mutation(() =>
      tools.call('writeFields', { cloudId: config.cloudId, issueKey: delivery.displayKey, fields: { labels } }, signal),
    )
  }
  if (delivery.desiredState === 'completed' && issue.fields.status.id !== config.reviewStatusId) {
    await mutation(() =>
      tools.call(
        'transitionIssue',
        {
          cloudId: config.cloudId,
          issueKey: delivery.displayKey,
          transitionId: config.reviewTransitionId,
        },
        signal,
      ),
    )
  }
  return { receiptId: `jira:projection:${delivery.deliveryId}`, receivedAt: new Date().toISOString() }
}

async function mutation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (
      error instanceof TrackerProviderError &&
      ['invalid-response', 'provider-unavailable', 'timeout', 'transient'].includes(error.code)
    ) {
      throw new TrackerProviderError('ambiguous-acknowledgement', 'Jira mutation acknowledgement was ambiguous')
    }
    throw error
  }
}

function assertDeliveryTarget(delivery: TrackerOutboundDelivery, config: JiraSettings): void {
  if (delivery.bindingId !== jiraBindingId(config)) {
    throw new TrackerProviderError('invalid-configuration', 'Jira delivery binding does not match provider settings')
  }
}

async function assertIdentity(
  config: JiraSettings,
  tools: McpTools<typeof jiraMcpContracts>,
  signal: AbortSignal,
): Promise<void> {
  const identity = await tools.call('readIdentity', {}, signal)
  if (identity.account_id !== config.integrationAccountId) {
    throw new TrackerProviderError(
      'provider-unavailable',
      'Jira MCP identity does not match the configured integration account',
    )
  }
}

async function readWritableIssue(
  delivery: TrackerOutboundDelivery,
  config: JiraSettings,
  tools: McpTools<typeof jiraMcpContracts>,
  signal: AbortSignal,
): Promise<JiraWritableIssue> {
  const issue = await tools.call('readIssue', { cloudId: config.cloudId, issueKey: delivery.displayKey }, signal)
  if (
    issue.id !== delivery.issueId ||
    issue.key !== delivery.displayKey ||
    issue.fields.project.id !== config.projectId
  ) {
    throw new TrackerProviderError('conflict', 'Jira delivery issue identity does not match the durable intent')
  }
  return issue
}

async function assertCurrentReadiness(
  delivery: Extract<TrackerOutboundDelivery, { kind: 'projection' }>,
  config: JiraSettings,
  tools: McpTools<typeof jiraMcpContracts>,
  signal: AbortSignal,
): Promise<void> {
  const current = normalizeReadiness(await readChangelogsForKey(delivery.displayKey, config, tools, signal), config)
  if (current.kind !== 'transition' || current.generation !== delivery.readinessGeneration) {
    throw new TrackerProviderError('conflict', 'Jira readiness changed after this projection intent was created')
  }
}

function projectionMatches(
  issue: JiraWritableIssue,
  delivery: Extract<TrackerOutboundDelivery, { kind: 'projection' }>,
  config: JiraSettings,
): boolean {
  return (
    sameLabels(issue.fields.labels, desiredLabels(issue.fields.labels, delivery.desiredState, config)) &&
    (delivery.desiredState !== 'completed' || issue.fields.status.id === config.reviewStatusId)
  )
}

function projectionReceipt(
  delivery: Extract<TrackerOutboundDelivery, { kind: 'projection' }>,
  issue: JiraWritableIssue,
): TrackerOutboundReceipt {
  return {
    receiptId: `jira:projection:${delivery.deliveryId}`,
    receivedAt: jiraTimestamp(issue.fields.updated, `issue ${issue.key}`),
  }
}

function desiredLabels(current: readonly string[], state: string, config: JiraSettings): string[] {
  const managed = new Set([
    config.readyLabel,
    config.queuedLabel,
    config.implementingLabel,
    config.pausedLabel,
    config.blockedLabel,
    config.failedLabel,
    config.completedLabel,
  ])
  const stateLabel = {
    queued: config.queuedLabel,
    implementing: config.implementingLabel,
    paused: config.pausedLabel,
    blocked: config.blockedLabel,
    failed: config.failedLabel,
    completed: config.completedLabel,
  }[state]
  if (stateLabel === undefined)
    throw new TrackerProviderError('invalid-configuration', 'Jira projection state is invalid')
  const retained = current.filter((label) => !managed.has(label))
  if (['queued', 'implementing', 'paused'].includes(state)) retained.push(config.readyLabel)
  retained.push(stateLabel)
  return [...new Set(retained)].sort()
}

function sameLabels(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join('\0') === [...right].sort().join('\0')
}

function reportMarker(eventId: string): string {
  return `<!-- dsh-autopilot:event:${eventId} -->`
}

async function readCommentsForKey(
  issueKey: string,
  config: JiraSettings,
  tools: McpTools<typeof jiraMcpContracts>,
  signal: AbortSignal,
): Promise<JiraComment[]> {
  return await readComments({ key: issueKey }, config, tools, signal)
}

async function readChangelogsForKey(
  issueKey: string,
  config: JiraSettings,
  tools: McpTools<typeof jiraMcpContracts>,
  signal: AbortSignal,
): Promise<JiraChangelog[]> {
  return await readChangelogs({ key: issueKey }, config, tools, signal)
}

async function readComments(
  issue: Pick<JiraIssue, 'key'>,
  config: JiraSettings,
  tools: McpTools<typeof jiraMcpContracts>,
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
  issue: Pick<JiraIssue, 'key'>,
  config: JiraSettings,
  tools: McpTools<typeof jiraMcpContracts>,
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
