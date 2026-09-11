import { createHash } from 'node:crypto'
import {
  readinessGeneration,
  type TrackerDependency,
  type TrackerIssueSnapshot,
  TrackerProviderError,
  type TrackerReadiness,
  trackerBindingId,
  trackerCommentId,
  trackerIssueId,
} from '../../tracker.js'
import { type JiraChangelog, type JiraComment, type JiraIssue, linkedIssueSchema, linkSchema } from './schemas.js'
import type { JiraSettings } from './settings.js'

export function normalizeIssue(
  issue: JiraIssue,
  config: JiraSettings,
  rawComments: readonly JiraComment[],
  changelogs: readonly JiraChangelog[],
): TrackerIssueSnapshot {
  const priorityId = issue.fields.priority?.id
  const priorityRank = priorityId === undefined ? undefined : config.priorityRanks[priorityId]
  if (priorityId === undefined || priorityRank === undefined || !Number.isInteger(priorityRank) || priorityRank < 0) {
    throw new TrackerProviderError('invalid-configuration', `Jira issue "${issue.key}" has no configured priority rank`)
  }

  const comments = rawComments.map((comment) => ({
    id: trackerCommentId(comment.id),
    authorId: comment.author?.accountId ?? 'unknown',
    body: adfToText(comment.body),
    updatedAt: jiraTimestamp(comment.updated, `comment ${comment.id}`),
  }))

  return {
    bindingId: trackerBindingId(
      `jira:${createHash('sha256').update(`${config.cloudId}\0${config.projectId}`).digest('hex').slice(0, 32)}`,
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

function normalizeReadiness(changes: readonly JiraChangelog[], config: JiraSettings): TrackerReadiness {
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

function labelSet(value: string | null | undefined): Set<string> {
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
