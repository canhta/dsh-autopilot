import { createHash } from 'node:crypto'
import {
  readinessGeneration,
  type TrackerComment,
  type TrackerDependency,
  type TrackerIssueSnapshot,
  TrackerProviderError,
  type TrackerReadiness,
  trackerBindingId,
  trackerCommentId,
  trackerIssueId,
} from '../../tracker.js'
import type { GitHubComment, GitHubDependency, GitHubIssue, GitHubTimelineEvent } from './schemas.js'
import type { GitHubIssuesSettings } from './settings.js'

export interface GitHubIssueEvidence {
  comments: readonly GitHubComment[]
  dependencies: readonly (GitHubDependency & { stateReason?: string })[]
  timeline: readonly GitHubTimelineEvent[]
}

export function normalizeIssue(
  issue: GitHubIssue,
  evidence: GitHubIssueEvidence,
  config: GitHubIssuesSettings,
): TrackerIssueSnapshot {
  return {
    bindingId: trackerBindingId(
      `github-issues:${createHash('sha256').update(config.repositoryId).digest('hex').slice(0, 32)}`,
    ),
    issueId: trackerIssueId(String(issue.number)),
    displayKey: `${config.repositoryOwner}/${config.repositoryName}#${String(issue.number)}`,
    summary: issue.title,
    priorityRank: priorityRank(issue.labels, config),
    isReady: issue.labels.includes(config.readyLabel),
    labels: [...issue.labels],
    comments: normalizeComments(evidence.comments),
    dependencies: normalizeDependencies(evidence.dependencies, config),
    readiness: normalizeReadiness(evidence.timeline, issue.labels, config),
  }
}

function normalizeComments(raw: readonly GitHubComment[]): TrackerComment[] {
  return raw.map((comment) => ({
    id: trackerCommentId(String(comment.id)),
    authorId: comment.user?.id === undefined ? 'unknown' : String(comment.user.id),
    body: comment.body ?? '',
    updatedAt: githubTimestamp(comment.updated_at, `comment ${String(comment.id)}`),
  }))
}

function normalizeDependencies(
  raw: readonly (GitHubDependency & { stateReason?: string })[],
  config: GitHubIssuesSettings,
): TrackerDependency[] {
  const dependencies = new Map<string, TrackerDependency>()
  for (const dependency of raw) {
    const repository = repositoryParts(dependency.repository)
    const nativeKey = `${repository.owner}/${repository.name}#${String(dependency.number)}`
    dependencies.set(nativeKey, {
      issueId: trackerIssueId(
        `github:${createHash('sha256').update(nativeKey.toLowerCase()).digest('hex').slice(0, 40)}`,
      ),
      displayKey: nativeKey,
      state:
        dependency.state === 'OPEN'
          ? 'not-completed'
          : dependency.stateReason !== undefined && config.completedStateReasons.includes(dependency.stateReason)
            ? 'completed'
            : 'unknown',
    })
  }
  return [...dependencies.values()].sort((left, right) => left.issueId.localeCompare(right.issueId))
}

function normalizeReadiness(
  events: readonly GitHubTimelineEvent[],
  labels: readonly string[],
  config: GitHubIssuesSettings,
): TrackerReadiness {
  const transitions = events
    .filter((event) => event.label.name === config.readyLabel)
    .map((event) => {
      if (String(event.repository_id) !== config.repositoryId) {
        throw new TrackerProviderError('invalid-configuration', 'GitHub Issues readiness repository did not match')
      }
      return { event, occurredAt: githubTimestamp(event.created_at, `timeline event ${String(event.id)}`) }
    })
    .sort((left, right) =>
      left.occurredAt === right.occurredAt
        ? left.event.id - right.event.id
        : left.occurredAt.localeCompare(right.occurredAt),
    )
  const latest = transitions.at(-1)
  if (latest === undefined) return { kind: 'absent' }
  if (transitions.at(-2)?.occurredAt === latest.occurredAt) {
    throw new TrackerProviderError('conflict', 'GitHub Issues readiness transition ordering is ambiguous')
  }
  const snapshotReady = labels.includes(config.readyLabel)
  const transitionReady = latest.event.event === 'labeled'
  if (snapshotReady !== transitionReady) {
    throw new TrackerProviderError('conflict', 'GitHub Issues readiness snapshot and timeline did not agree')
  }
  if (!transitionReady) return { kind: 'absent' }
  const actorId = latest.event.actor === null ? 'unknown' : String(latest.event.actor.id)
  return {
    kind: 'transition',
    generation: readinessGeneration(`github-issues:${String(latest.event.id)}`),
    actorId,
    actorKind: classifyActor(latest.event, actorId, config),
    occurredAt: latest.occurredAt,
  }
}

function classifyActor(
  event: GitHubTimelineEvent,
  actorId: string,
  config: GitHubIssuesSettings,
): 'human' | 'automation' | 'unknown' {
  if (
    actorId === config.integrationActorId ||
    config.automationActorIds.includes(actorId) ||
    event.actor?.type === 'Bot' ||
    event.performed_via_github_app != null
  ) {
    return 'automation'
  }
  return event.actor?.type === 'User' && config.trustedHumanActorIds.includes(actorId) ? 'human' : 'unknown'
}

function priorityRank(labels: readonly string[], config: GitHubIssuesSettings): number {
  let rank: number | undefined
  for (const label of labels) {
    const mapped = Object.hasOwn(config.priorityLabelRanks, label) ? config.priorityLabelRanks[label] : undefined
    if (mapped !== undefined && (rank === undefined || mapped < rank)) rank = mapped
  }
  return rank ?? config.defaultPriorityRank
}

function repositoryParts(repository: string): { owner: string; name: string } {
  const [owner, name, ...rest] = repository.split('/')
  if (
    rest.length > 0 ||
    owner === undefined ||
    name === undefined ||
    !validRepositoryPart(owner) ||
    !validRepositoryPart(name)
  ) {
    throw new TrackerProviderError('invalid-response', 'GitHub Issues dependency repository was not identifiable')
  }
  return { owner, name }
}

function validRepositoryPart(value: string): boolean {
  return value !== '.' && value !== '..' && /^[A-Za-z0-9_.-]{1,100}$/.test(value)
}

function githubTimestamp(value: string, subject: string): string {
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) {
    throw new TrackerProviderError('invalid-response', `GitHub Issues ${subject} had an invalid timestamp`)
  }
  return timestamp.toISOString()
}
