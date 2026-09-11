import { credentialRef } from '@deepseek-ai/dsh-credentials'
import s from '@deepseek-ai/schemastery'
import { TrackerProviderError } from '../../tracker.js'

export interface JiraSettings {
  siteUrl: string
  cloudId: string
  projectKey: string
  email: string
  integrationAccountId: string
  credentialRef: string
  webhookSecretRef: string
  readyLabel: string
  pageSize: number
  requestTimeoutMs: number
  priorityRanks: Record<string, number>
  doneStatusIds: string[]
  blockingLinkTypeIds: string[]
  dependencyDirection: 'inward' | 'outward'
  automationAccountIds: string[]
  trustedHumanAccountIds: string[]
}

export const jiraSettingsSchema: s<JiraSettings> = s.object({
  siteUrl: s.string().default(''),
  cloudId: s.string().default(''),
  projectKey: s.string().default(''),
  email: s.string().default(''),
  integrationAccountId: s.string().default(''),
  credentialRef: s.string().default('DSH_AUTOPILOT_JIRA_TOKEN'),
  webhookSecretRef: s.string().default('DSH_AUTOPILOT_JIRA_WEBHOOK_SECRET'),
  readyLabel: s.string().default('ready-for-agent'),
  pageSize: s.number().min(1).max(100).default(50),
  requestTimeoutMs: s.number().min(100).max(120_000).default(10_000),
  priorityRanks: s.dict(s.number().min(0)).default({}),
  doneStatusIds: s.array(s.string()).default([]),
  blockingLinkTypeIds: s.array(s.string()).default([]),
  dependencyDirection: s.union(['inward', 'outward'] as const).default('inward'),
  automationAccountIds: s.array(s.string()).default([]),
  trustedHumanAccountIds: s.array(s.string()).default([]),
})

export function validateStoredSettings(config: JiraSettings): void {
  if (!Number.isInteger(config.pageSize)) throw new TypeError('Jira page size must be an integer')
  if (!Number.isInteger(config.requestTimeoutMs)) throw new TypeError('Jira request timeout must be an integer')
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
