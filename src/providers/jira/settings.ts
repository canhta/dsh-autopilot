import { isDeepStrictEqual } from 'node:util'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import s from '@deepseek-ai/schemastery'
import { TrackerProviderError } from '../../tracker.js'

export interface JiraSettings {
  mcpServerName: string
  cloudId: string
  projectId: string
  integrationAccountId: string
  webhookSecretRef: string
  readyLabel: string
  pageSize: number
  maxPagesPerTraversal: number
  maxItemsPerTraversal: number
  priorityRanks: Record<string, number>
  doneStatusIds: string[]
  blockingLinkTypeIds: string[]
  dependencyDirection: 'inward' | 'outward'
  automationAccountIds: string[]
  trustedHumanAccountIds: string[]
  queuedLabel: string
  implementingLabel: string
  pausedLabel: string
  blockedLabel: string
  failedLabel: string
  completedLabel: string
  reviewTransitionId: string
  reviewStatusId: string
}

const protectedSettingKeys = [
  'mcpServerName',
  'cloudId',
  'projectId',
  'integrationAccountId',
  'readyLabel',
  'priorityRanks',
  'doneStatusIds',
  'blockingLinkTypeIds',
  'dependencyDirection',
  'automationAccountIds',
  'trustedHumanAccountIds',
  'queuedLabel',
  'implementingLabel',
  'pausedLabel',
  'blockedLabel',
  'failedLabel',
  'completedLabel',
  'reviewTransitionId',
  'reviewStatusId',
] as const satisfies readonly (keyof JiraSettings)[]

/** Whether a Settings edit would reinterpret an existing Jira run or delivery intent. */
export function changesJiraBinding(current: JiraSettings, next: JiraSettings): boolean {
  return protectedSettingKeys.some((key) => !isDeepStrictEqual(current[key], next[key]))
}

export const jiraSettingsSchema: s<JiraSettings> = s.object({
  mcpServerName: s.string().default('atlassian'),
  cloudId: s.string().default(''),
  projectId: s.string().default(''),
  integrationAccountId: s.string().default(''),
  webhookSecretRef: s.string().default('DSH_AUTOPILOT_JIRA_WEBHOOK_SECRET'),
  readyLabel: s.string().default('ready-for-agent'),
  pageSize: s.number().min(1).max(100).default(50),
  maxPagesPerTraversal: s.number().min(1).max(1_000).default(100),
  maxItemsPerTraversal: s.number().min(1).max(10_000).default(10_000),
  priorityRanks: s.dict(s.number().min(0)).default({}),
  doneStatusIds: s.array(s.string()).default([]),
  blockingLinkTypeIds: s.array(s.string()).default([]),
  dependencyDirection: s.union(['inward', 'outward'] as const).default('inward'),
  automationAccountIds: s.array(s.string()).default([]),
  trustedHumanAccountIds: s.array(s.string()).default([]),
  queuedLabel: s.string().default('agent-queued'),
  implementingLabel: s.string().default('agent-implementing'),
  pausedLabel: s.string().default('agent-paused'),
  blockedLabel: s.string().default('agent-blocked'),
  failedLabel: s.string().default('agent-failed'),
  completedLabel: s.string().default('agent-completed'),
  reviewTransitionId: s.string().default(''),
  reviewStatusId: s.string().default(''),
})

export function validateStoredSettings(config: JiraSettings): void {
  if (!Number.isInteger(config.pageSize) || config.pageSize < 1 || config.pageSize > 100) {
    throw new TypeError('Jira page size must be an integer from 1 through 100')
  }
  if (
    !Number.isInteger(config.maxPagesPerTraversal) ||
    config.maxPagesPerTraversal < 1 ||
    config.maxPagesPerTraversal > 1_000
  ) {
    throw new TypeError('Jira maximum pages must be an integer from 1 through 1000')
  }
  if (
    !Number.isInteger(config.maxItemsPerTraversal) ||
    config.maxItemsPerTraversal < 1 ||
    config.maxItemsPerTraversal > 10_000
  ) {
    throw new TypeError('Jira maximum items must be an integer from 1 through 10000')
  }
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(config.mcpServerName)) throw new TypeError('Jira MCP server name is invalid')
  if (config.integrationAccountId.length > 256) throw new TypeError('Jira integration account id is too long')
  if (config.readyLabel !== '' && !/^[^,\s]{1,255}$/.test(config.readyLabel)) {
    throw new TypeError('Jira ready label is invalid')
  }
  const projectionLabels = [
    config.readyLabel,
    config.queuedLabel,
    config.implementingLabel,
    config.pausedLabel,
    config.blockedLabel,
    config.failedLabel,
    config.completedLabel,
  ]
  if (
    projectionLabels.some((label) => !/^[^,\s]{1,255}$/.test(label)) ||
    new Set(projectionLabels).size !== projectionLabels.length
  ) {
    throw new TypeError('Jira projection labels must be valid and unique')
  }
  for (const [name, value] of [
    ['review transition', config.reviewTransitionId],
    ['review status', config.reviewStatusId],
  ] as const) {
    if (value !== '' && (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value))) {
      throw new TypeError(`Jira ${name} id is invalid`)
    }
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
  if (config.cloudId !== '' && !/^[a-zA-Z0-9-]{1,128}$/.test(config.cloudId)) {
    throw new TypeError('Jira cloud id is invalid')
  }
  if (config.projectId !== '' && !/^[1-9][0-9]{0,19}$/.test(config.projectId)) {
    throw new TypeError('Jira project id is invalid')
  }
  if (config.webhookSecretRef !== '') credentialRef(config.webhookSecretRef)
}

export function requireIngressConfiguredSettings(config: JiraSettings): JiraSettings {
  if (config.cloudId === '' || config.webhookSecretRef === '') {
    throw new TrackerProviderError('invalid-configuration', 'Jira webhook settings are incomplete')
  }
  try {
    validateStoredSettings(config)
  } catch {
    throw new TrackerProviderError('invalid-configuration', 'Jira webhook settings are invalid')
  }
  return config
}

export function requireConfiguredSettings(config: JiraSettings): JiraSettings {
  const missing = ['mcpServerName', 'cloudId', 'projectId', 'integrationAccountId', 'readyLabel'].filter(
    (field) => config[field as keyof JiraSettings] === '',
  )
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
  if (config.reviewTransitionId === '' || config.reviewStatusId === '') {
    throw new TrackerProviderError('invalid-configuration', 'Jira review transition and status mappings are required')
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
