import { credentialRef } from '@deepseek-ai/dsh-credentials'
import s from '@deepseek-ai/schemastery'
import { TrackerProviderError } from '../../tracker.js'

export interface GitHubIssuesSettings {
  mcpServerName: string
  repositoryOwner: string
  repositoryName: string
  repositoryId: string
  integrationActorId: string
  webhookSecretRef: string
  readyLabel: string
  pageSize: number
  maxPagesPerTraversal: number
  maxItemsPerTraversal: number
  priorityLabelRanks: Record<string, number>
  defaultPriorityRank: number
  completedStateReasons: string[]
  automationActorIds: string[]
  trustedHumanActorIds: string[]
}

export const githubIssuesSettingsSchema: s<GitHubIssuesSettings> = s.object({
  mcpServerName: s.string().default('github'),
  repositoryOwner: s.string().default(''),
  repositoryName: s.string().default(''),
  repositoryId: s.string().default(''),
  integrationActorId: s.string().default(''),
  webhookSecretRef: s.string().default('DSH_AUTOPILOT_GITHUB_ISSUES_WEBHOOK_SECRET'),
  readyLabel: s.string().default('ready-for-agent'),
  pageSize: s.number().min(1).max(100).default(50),
  maxPagesPerTraversal: s.number().min(1).max(1_000).default(100),
  maxItemsPerTraversal: s.number().min(1).max(10_000).default(10_000),
  priorityLabelRanks: s.dict(s.number().min(0)).default({}),
  defaultPriorityRank: s.number().min(0).default(100),
  completedStateReasons: s.array(s.string()).default(['completed']),
  automationActorIds: s.array(s.string()).default([]),
  trustedHumanActorIds: s.array(s.string()).default([]),
})

/** Validate persisted GitHub Issues settings; throws `TypeError` and has no side effects or cancellation point. */
export function validateStoredSettings(config: GitHubIssuesSettings): void {
  if (!Number.isInteger(config.pageSize) || config.pageSize < 1 || config.pageSize > 100) {
    throw new TypeError('GitHub Issues page size must be an integer from 1 through 100')
  }
  if (
    !Number.isInteger(config.maxPagesPerTraversal) ||
    config.maxPagesPerTraversal < 1 ||
    config.maxPagesPerTraversal > 1_000
  ) {
    throw new TypeError('GitHub Issues maximum pages per traversal must be an integer from 1 through 1000')
  }
  if (
    !Number.isInteger(config.maxItemsPerTraversal) ||
    config.maxItemsPerTraversal < 1 ||
    config.maxItemsPerTraversal > 10_000
  ) {
    throw new TypeError('GitHub Issues maximum items per traversal must be an integer from 1 through 10000')
  }
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(config.mcpServerName)) {
    throw new TypeError('GitHub Issues MCP server name is invalid')
  }
  if (!Number.isInteger(config.defaultPriorityRank) || config.defaultPriorityRank < 0) {
    throw new TypeError('GitHub Issues default priority rank must be a non-negative integer')
  }
  validateRepositoryPart(config.repositoryOwner, 'owner')
  validateRepositoryPart(config.repositoryName, 'name')
  validateOptionalNumericId(config.repositoryId, 'repository id')
  validateOptionalNumericId(config.integrationActorId, 'integration actor id')
  if (config.readyLabel !== '' && (config.readyLabel.length > 255 || /[\r\n]/.test(config.readyLabel))) {
    throw new TypeError('GitHub Issues ready label is invalid')
  }
  if (Object.keys(config.priorityLabelRanks).length > 256) {
    throw new TypeError('GitHub Issues priority label mapping is too large')
  }
  for (const [label, rank] of Object.entries(config.priorityLabelRanks)) {
    if (label.length === 0 || label.length > 255 || /[\r\n]/.test(label)) {
      throw new TypeError('GitHub Issues priority label mapping contains an invalid label')
    }
    if (!Number.isInteger(rank) || rank < 0) {
      throw new TypeError('GitHub Issues priority ranks must be non-negative integers')
    }
  }
  validateStringList(config.completedStateReasons, 'completed state reason', 64)
  validateIdList(config.automationActorIds, 'automation actor')
  validateIdList(config.trustedHumanActorIds, 'trusted human actor')
  validateDisjointActors(config)
  if (config.webhookSecretRef !== '') credentialRef(config.webhookSecretRef)
}

/** Require the settings needed to authenticate ingress; rejects sanitized with `TrackerProviderError`. */
export function requireIngressConfiguredSettings(config: GitHubIssuesSettings): GitHubIssuesSettings {
  if (config.repositoryId === '' || config.webhookSecretRef === '') {
    throw new TrackerProviderError('invalid-configuration', 'GitHub Issues webhook settings are incomplete')
  }
  validateProviderSettings(config, 'webhook')
  return config
}

/** Require the complete read configuration; rejects sanitized with `TrackerProviderError`. */
export function requireConfiguredSettings(config: GitHubIssuesSettings): GitHubIssuesSettings {
  const missing = [
    'repositoryOwner',
    'repositoryName',
    'repositoryId',
    'integrationActorId',
    'mcpServerName',
    'readyLabel',
  ].filter((field) => config[field as keyof GitHubIssuesSettings] === '')
  if (missing.length > 0) {
    throw new TrackerProviderError(
      'invalid-configuration',
      `GitHub Issues settings are incomplete: ${missing.join(', ')}`,
    )
  }
  if (config.completedStateReasons.length === 0) {
    throw new TrackerProviderError('invalid-configuration', 'GitHub Issues completed-state mapping is required')
  }
  if (config.trustedHumanActorIds.length === 0) {
    throw new TrackerProviderError('invalid-configuration', 'GitHub Issues trusted-human mapping is required')
  }
  validateProviderSettings(config, 'read')
  return config
}

function validateProviderSettings(config: GitHubIssuesSettings, operation: string): void {
  try {
    validateStoredSettings(config)
  } catch {
    throw new TrackerProviderError('invalid-configuration', `GitHub Issues ${operation} settings are invalid`)
  }
}

function validateRepositoryPart(value: string, part: string): void {
  if (value !== '' && (value.length > 100 || value === '.' || value === '..' || !/^[A-Za-z0-9_.-]+$/.test(value))) {
    throw new TypeError(`GitHub Issues repository ${part} is invalid`)
  }
}

function validateOptionalNumericId(value: string, subject: string): void {
  if (value !== '' && (!/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new TypeError(`GitHub Issues ${subject} must be a positive numeric string`)
  }
}

function validateStringList(values: readonly string[], subject: string, maxLength: number): void {
  if (values.length > 256 || values.some((value) => value.length === 0 || value.length > maxLength)) {
    throw new TypeError(`GitHub Issues ${subject} mapping is invalid`)
  }
  if (new Set(values).size !== values.length)
    throw new TypeError(`GitHub Issues ${subject} mapping contains duplicates`)
}

function validateIdList(values: readonly string[], subject: string): void {
  if (values.length > 256) throw new TypeError(`GitHub Issues ${subject} mapping is too large`)
  for (const value of values) validateOptionalNumericId(value, subject)
  if (new Set(values).size !== values.length)
    throw new TypeError(`GitHub Issues ${subject} mapping contains duplicates`)
}

function validateDisjointActors(config: GitHubIssuesSettings): void {
  const automation = new Set([config.integrationActorId, ...config.automationActorIds].filter(Boolean))
  if (config.trustedHumanActorIds.some((actorId) => automation.has(actorId))) {
    throw new TypeError('GitHub Issues automation and trusted-human actor mappings must be disjoint')
  }
}
