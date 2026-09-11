import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import {
  readinessGeneration,
  type TrackerComment,
  type TrackerDependency,
  type TrackerIssueSnapshot,
  type TrackerProvider,
  TrackerProviderError,
  type TrackerReadiness,
  trackerBindingId,
  trackerCommentId,
  trackerIssueId,
  trackerProviderId,
} from './tracker.js'

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_OPERATION_RESPONSE_BYTES = 8 * 1024 * 1024
const jiraProviderId = trackerProviderId('jira')

export const name = 'dsh-autopilot-jira'
export const inject = ['tracker', 'settings', 'credentials']

interface JiraSettings {
  siteUrl: string
  cloudId: string
  projectKey: string
  email: string
  integrationAccountId: string
  credentialRef: string
  readyLabel: string
  pageSize: number
  priorityRanks: Record<string, number>
  doneStatusIds: string[]
  blockingLinkTypeIds: string[]
  dependencyDirection: 'inward' | 'outward'
  automationAccountIds: string[]
  trustedHumanAccountIds: string[]
}

const jiraSettingsSchema: s<JiraSettings> = s.object({
  siteUrl: s.string().default(''),
  cloudId: s.string().default(''),
  projectKey: s.string().default(''),
  email: s.string().default(''),
  integrationAccountId: s.string().default(''),
  credentialRef: s.string().default('DSH_AUTOPILOT_JIRA_TOKEN'),
  readyLabel: s.string().default('ready-for-agent'),
  pageSize: s.number().min(1).max(100).default(50),
  priorityRanks: s.dict(s.number().min(0)).default({}),
  doneStatusIds: s.array(s.string()).default([]),
  blockingLinkTypeIds: s.array(s.string()).default([]),
  dependencyDirection: s.union(['inward', 'outward'] as const).default('inward'),
  automationAccountIds: s.array(s.string()).default([]),
  trustedHumanAccountIds: s.array(s.string()).default([]),
})

const issueSchema = z.object({
  id: z.string().min(1).max(256),
  key: z.string().min(1).max(256),
  fields: z.object({
    summary: z.string(),
    priority: z
      .object({ id: z.string().min(1).max(256) })
      .nullable()
      .optional(),
    labels: z.array(z.string()),
    issuelinks: z.array(z.unknown()).default([]),
  }),
})

const searchSchema = z.object({
  issues: z.array(issueSchema),
  nextPageToken: z.string().min(1).max(4096).optional(),
})

const commentSchema = z.object({
  id: z.string().min(1).max(256),
  author: z.object({ accountId: z.string().min(1).max(256).optional() }).optional(),
  updated: z.string().min(1).max(128),
  body: z.unknown(),
})

const commentsPageSchema = z.object({
  startAt: z.number().int().nonnegative(),
  maxResults: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  comments: z.array(commentSchema),
})

const changelogItemSchema = z.object({
  fieldId: z.string().optional(),
  field: z.string().optional(),
  fromString: z.string().nullable().optional(),
  toString: z.string().nullable().optional(),
})

const changelogSchema = z.object({
  id: z.string().min(1).max(256),
  created: z.string().min(1).max(128),
  author: z
    .object({
      accountId: z.string().min(1).max(256).optional(),
      accountType: z.string().min(1).max(64).optional(),
    })
    .optional(),
  items: z.array(changelogItemSchema),
})

const changelogPageSchema = z.object({
  startAt: z.number().int().nonnegative(),
  maxResults: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  values: z.array(changelogSchema),
})

const linkSchema = z.object({
  type: z.object({ id: z.string().min(1).max(256) }),
  inwardIssue: z.unknown().optional(),
  outwardIssue: z.unknown().optional(),
})

const linkedIssueSchema = z.object({
  id: z.string().min(1).max(256),
  key: z.string().min(1).max(256),
  fields: z
    .object({
      status: z.object({ id: z.string().min(1).max(256) }).optional(),
    })
    .optional(),
})

/**
 * Register the Jira Settings namespace and tracker provider on the calling plugin fiber.
 * The caller must inject tracker, settings, and credentials and own the returned async provider disposer through an
 * effect. Configuration/credential/provider failures reject reads; provider withdrawal aborts and drains active HTTP.
 */
export function registerJiraProvider(ctx: Context, fetchImplementation: typeof fetch): () => Promise<void> {
  const settings = ctx.settings.register('dsh-autopilot-jira', jiraSettingsSchema, {
    validate: validateStoredSettings,
  })
  return ctx.tracker.register(createJiraProvider(ctx, settings, fetchImplementation))
}

export function apply(ctx: Context): void {
  ctx.effect(() => registerJiraProvider(ctx, globalThis.fetch))
}

function createJiraProvider(
  ctx: Context,
  settings: SettingsScope<JiraSettings>,
  fetchImplementation: typeof fetch,
): TrackerProvider {
  return {
    id: jiraProviderId,
    interfaceVersion: 1,
    displayName: 'Jira Cloud',
    configurationNamespace: 'dsh-autopilot-jira',
    capabilities: ['candidates', 'comments', 'dependencies', 'readiness'],
    async readCandidates({ cursor, signal }) {
      const config = requireConfiguredSettings(settings.get())
      const resolved = await ctx.credentials.resolve(credentialRef(config.credentialRef))
      if (resolved === undefined) {
        throw new TrackerProviderError('authentication', 'Jira credential reference is not configured')
      }
      const request = jiraRequest(fetchImplementation, config, resolved.value, signal)
      const raw = await request('/rest/api/3/search/jql', {
        method: 'POST',
        body: JSON.stringify({
          jql: `project = "${escapeJql(config.projectKey)}" AND labels = "${escapeJql(config.readyLabel)}" ORDER BY created ASC, key ASC`,
          fields: ['summary', 'priority', 'labels', 'issuelinks'],
          maxResults: config.pageSize,
          ...(cursor === undefined ? {} : { nextPageToken: cursor }),
        }),
      })
      const page = parseProviderResponse(searchSchema, raw, 'Jira search response')
      const issues: TrackerIssueSnapshot[] = []
      for (const issue of page.issues) issues.push(await normalizeIssue(issue, config, request))
      return {
        issues,
        ...(page.nextPageToken === undefined ? {} : { nextCursor: page.nextPageToken }),
      }
    },
  }
}

type JiraIssue = z.infer<typeof issueSchema>
type JiraRequest = (path: string, init?: RequestInit) => Promise<unknown>

async function normalizeIssue(
  issue: JiraIssue,
  config: JiraSettings,
  request: JiraRequest,
): Promise<TrackerIssueSnapshot> {
  const priorityId = issue.fields.priority?.id
  const priorityRank = priorityId === undefined ? undefined : config.priorityRanks[priorityId]
  if (priorityId === undefined || priorityRank === undefined || !Number.isInteger(priorityRank) || priorityRank < 0) {
    throw new TrackerProviderError('invalid-configuration', `Jira issue "${issue.key}" has no configured priority rank`)
  }

  const comments = await readComments(issue.key, config.pageSize, request)
  const changelogs = await readChangelogs(issue.key, config.pageSize, request)

  return {
    bindingId: trackerBindingId(
      `jira:${createHash('sha256').update(`${config.cloudId}\0${config.projectKey}`).digest('hex').slice(0, 32)}`,
    ),
    issueId: trackerIssueId(issue.id),
    displayKey: issue.key,
    summary: issue.fields.summary,
    priorityRank,
    isReady: issue.fields.labels.includes(config.readyLabel),
    labels: [...issue.fields.labels],
    comments,
    dependencies: normalizeDependencies(issue.fields.issuelinks, config),
    readiness: normalizeReadiness(changelogs, config),
  }
}

async function readComments(issueKey: string, pageSize: number, request: JiraRequest): Promise<TrackerComment[]> {
  const comments: TrackerComment[] = []
  let startAt = 0
  while (true) {
    const raw = await request(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?startAt=${String(startAt)}&maxResults=${String(pageSize)}`,
    )
    const page = parseProviderResponse(commentsPageSchema, raw, `Jira comments for "${issueKey}"`)
    for (const comment of page.comments) {
      comments.push({
        id: trackerCommentId(comment.id),
        authorId: comment.author?.accountId ?? 'unknown',
        body: adfToText(comment.body),
        updatedAt: jiraTimestamp(comment.updated, `comment ${comment.id}`),
      })
    }
    const next = page.startAt + page.comments.length
    if (next >= page.total) return comments
    if (page.comments.length === 0 || next <= startAt) {
      throw new TrackerProviderError('invalid-response', `Jira comments for "${issueKey}" did not advance pagination`)
    }
    startAt = next
  }
}

async function readChangelogs(
  issueKey: string,
  pageSize: number,
  request: JiraRequest,
): Promise<Array<z.infer<typeof changelogSchema>>> {
  const changes: Array<z.infer<typeof changelogSchema>> = []
  let startAt = 0
  while (true) {
    const raw = await request(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/changelog?startAt=${String(startAt)}&maxResults=${String(pageSize)}`,
    )
    const page = parseProviderResponse(changelogPageSchema, raw, `Jira changelog for "${issueKey}"`)
    changes.push(...page.values)
    const next = page.startAt + page.values.length
    if (next >= page.total) return changes
    if (page.values.length === 0 || next <= startAt) {
      throw new TrackerProviderError('invalid-response', `Jira changelog for "${issueKey}" did not advance pagination`)
    }
    startAt = next
  }
}

function normalizeDependencies(rawLinks: readonly unknown[], config: JiraSettings): TrackerDependency[] {
  const dependencies: TrackerDependency[] = []
  for (const raw of rawLinks) {
    const link = linkSchema.safeParse(raw)
    if (!link.success) throw new TrackerProviderError('invalid-response', 'Jira returned a malformed issue link')
    if (!config.blockingLinkTypeIds.includes(link.data.type.id)) continue
    const linkedRaw = config.dependencyDirection === 'inward' ? link.data.inwardIssue : link.data.outwardIssue
    const linked = linkedIssueSchema.safeParse(linkedRaw)
    if (!linked.success) {
      throw new TrackerProviderError(
        'invalid-response',
        'Jira did not return accessible facts for a blocking dependency',
      )
    }
    const statusId = linked.data.fields?.status?.id
    dependencies.push({
      issueId: trackerIssueId(linked.data.id),
      displayKey: linked.data.key,
      state:
        statusId === undefined ? 'unknown' : config.doneStatusIds.includes(statusId) ? 'completed' : 'not-completed',
    })
  }
  return dependencies
}

function normalizeReadiness(
  changes: readonly z.infer<typeof changelogSchema>[],
  config: JiraSettings,
): TrackerReadiness {
  const transitions = changes
    .filter((change) =>
      change.items.some(
        (item) =>
          (item.fieldId === 'labels' || item.field === 'labels') &&
          !labelSet(item.fromString).has(config.readyLabel) &&
          labelSet(item.toString).has(config.readyLabel),
      ),
    )
    .map((change) => ({ change, occurredAt: jiraTimestamp(change.created, `changelog ${change.id}`) }))
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
  const latest = transitions.at(-1)
  if (latest === undefined) return { kind: 'absent' }
  if (transitions.at(-2)?.occurredAt === latest.occurredAt) {
    throw new TrackerProviderError('conflict', 'Jira readiness transition ordering is ambiguous')
  }

  const actorId = latest.change.author?.accountId ?? 'unknown'
  const accountType = latest.change.author?.accountType
  const actorKind =
    actorId === config.integrationAccountId || config.automationAccountIds.includes(actorId) || accountType === 'app'
      ? 'automation'
      : (accountType === 'atlassian' || accountType === 'customer') && config.trustedHumanAccountIds.includes(actorId)
        ? 'human'
        : 'unknown'
  return {
    kind: 'transition',
    generation: readinessGeneration(`jira:${latest.change.id}`),
    actorId,
    actorKind,
    occurredAt: latest.occurredAt,
  }
}

function jiraRequest(
  fetchImplementation: typeof fetch,
  config: JiraSettings,
  token: string,
  signal: AbortSignal,
): JiraRequest {
  const authorization = `Basic ${Buffer.from(`${config.email}:${token}`).toString('base64')}`
  let consumedResponseBytes = 0
  return async (path, init = {}) => {
    let response: Response
    try {
      response = await fetchImplementation(
        `https://api.atlassian.com/ex/jira/${encodeURIComponent(config.cloudId)}${path}`,
        {
          ...init,
          signal,
          headers: {
            accept: 'application/json',
            authorization,
            ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
        },
      )
    } catch {
      throw new TrackerProviderError('transient', 'Jira request failed before receiving a response')
    }
    if (!response.ok) throw jiraHttpError(response)
    const remaining = MAX_OPERATION_RESPONSE_BYTES - consumedResponseBytes
    const result = await readBoundedJson(response, Math.min(MAX_RESPONSE_BYTES, remaining))
    consumedResponseBytes += result.byteLength
    return result.value
  }
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<{ value: unknown; byteLength: number }> {
  if (maxBytes <= 0) {
    await response.body?.cancel()
    throw new TrackerProviderError('invalid-response', 'Jira operation exceeded the response safety bound')
  }
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel()
    throw new TrackerProviderError('invalid-response', 'Jira response exceeded the configured safety bound')
  }
  if (response.body === null) throw new TrackerProviderError('invalid-response', 'Jira returned an empty response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new TrackerProviderError('invalid-response', 'Jira response exceeded the configured safety bound')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) as unknown, byteLength: total }
  } catch {
    throw new TrackerProviderError('invalid-response', 'Jira returned malformed JSON')
  }
}

function jiraHttpError(response: Response): TrackerProviderError {
  if (response.status === 401) return new TrackerProviderError('authentication', 'Jira rejected authentication')
  if (response.status === 403) return new TrackerProviderError('permission', 'Jira denied the requested operation')
  if (response.status === 404) return new TrackerProviderError('not-found', 'Jira resource was not found')
  if (response.status === 409) return new TrackerProviderError('conflict', 'Jira reported a conflicting change')
  if (response.status === 429) {
    return new TrackerProviderError('rate-limit', 'Jira rate limit was reached', retryAfterMs(response.headers))
  }
  if (response.status >= 500) return new TrackerProviderError('transient', 'Jira is temporarily unavailable')
  return new TrackerProviderError('invalid-response', `Jira rejected the request with HTTP ${String(response.status)}`)
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get('retry-after')
  if (value === null) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const time = Date.parse(value)
  return Number.isNaN(time) ? undefined : Math.max(0, time - Date.now())
}

function parseProviderResponse<T>(schema: z.ZodType<T>, value: unknown, subject: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new TrackerProviderError('invalid-response', `${subject} was malformed`)
  return parsed.data
}

function validateStoredSettings(config: JiraSettings): void {
  if (!Number.isInteger(config.pageSize)) throw new TypeError('Jira page size must be an integer')
  if (config.siteUrl.length > 2048) throw new TypeError('Jira site URL is too long')
  if (config.email !== '' && (config.email.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(config.email))) {
    throw new TypeError('Jira integration email is invalid')
  }
  if (config.integrationAccountId.length > 256) throw new TypeError('Jira integration account id is too long')
  if (config.readyLabel !== '' && !/^[^,\s]{1,255}$/.test(config.readyLabel)) {
    throw new TypeError('Jira ready label is invalid')
  }
  if (Object.keys(config.priorityRanks).length > 256) throw new TypeError('Jira priority mapping is too large')
  for (const rank of Object.values(config.priorityRanks)) {
    if (!Number.isInteger(rank) || rank < 0) throw new TypeError('Jira priority ranks must be non-negative integers')
  }
  for (const [name, values] of [
    ['done status', config.doneStatusIds],
    ['blocking link type', config.blockingLinkTypeIds],
    ['automation account', config.automationAccountIds],
    ['trusted human account', config.trustedHumanAccountIds],
  ] as const) {
    if (values.length > 256 || values.some((value) => value.length === 0 || value.length > 256)) {
      throw new TypeError(`Jira ${name} mapping is invalid`)
    }
  }
  if (config.siteUrl !== '') validateSiteUrl(config.siteUrl)
  if (config.cloudId !== '' && !/^[a-zA-Z0-9-]{1,128}$/.test(config.cloudId)) {
    throw new TypeError('Jira cloud id is invalid')
  }
  if (config.projectKey !== '' && !/^[A-Z][A-Z0-9_]{0,254}$/.test(config.projectKey)) {
    throw new TypeError('Jira project key is invalid')
  }
  if (config.credentialRef !== '') credentialRef(config.credentialRef)
}

function requireConfiguredSettings(config: JiraSettings): JiraSettings {
  const missing = [
    'siteUrl',
    'cloudId',
    'projectKey',
    'email',
    'integrationAccountId',
    'credentialRef',
    'readyLabel',
  ].filter((field) => config[field as keyof JiraSettings] === '')
  if (missing.length > 0) {
    throw new TrackerProviderError('invalid-configuration', `Jira settings are incomplete: ${missing.join(', ')}`)
  }
  if (config.blockingLinkTypeIds.length === 0) {
    throw new TrackerProviderError('invalid-configuration', 'Jira blocking-link mapping is required')
  }
  if (config.doneStatusIds.length === 0) {
    throw new TrackerProviderError('invalid-configuration', 'Jira completed-status mapping is required')
  }
  if (config.trustedHumanAccountIds.length === 0) {
    throw new TrackerProviderError('invalid-configuration', 'Jira trusted-human mapping is required')
  }
  const automationIds = new Set([config.integrationAccountId, ...config.automationAccountIds])
  if (config.trustedHumanAccountIds.some((accountId) => automationIds.has(accountId))) {
    throw new TrackerProviderError(
      'invalid-configuration',
      'Jira automation and trusted-human account mappings must be disjoint',
    )
  }
  try {
    validateStoredSettings(config)
  } catch {
    throw new TrackerProviderError('invalid-configuration', 'Jira settings are invalid')
  }
  return config
}

function validateSiteUrl(value: string): void {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new TypeError('Jira site URL must be an HTTPS origin or path without credentials, query or fragment')
  }
}

function escapeJql(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function labelSet(value: string | null | undefined): Set<string> {
  // Jira changelog payloads have used both commas and spaces between labels.
  return new Set(
    (value ?? '')
      .split(/[,\s]+/)
      .map((label) => label.trim())
      .filter(Boolean),
  )
}

function jiraTimestamp(value: string, subject: string): string {
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) {
    throw new TrackerProviderError('invalid-response', `Jira ${subject} has an invalid timestamp`)
  }
  return timestamp.toISOString()
}

function adfToText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(adfToText).join('')
  if (typeof value !== 'object' || value === null) return ''
  const node = value as { type?: unknown; text?: unknown; content?: unknown; attrs?: unknown }
  if (typeof node.text === 'string') return node.text
  if (node.type === 'hardBreak') return '\n'
  const content = adfToText(node.content)
  if (node.type === 'heading') {
    const level =
      typeof node.attrs === 'object' &&
      node.attrs !== null &&
      'level' in node.attrs &&
      Number.isInteger(node.attrs.level) &&
      Number(node.attrs.level) >= 1 &&
      Number(node.attrs.level) <= 6
        ? Number(node.attrs.level)
        : 1
    return `${'#'.repeat(level)} ${content}\n`
  }
  return ['paragraph', 'listItem'].includes(String(node.type)) ? `${content}\n` : content
}
