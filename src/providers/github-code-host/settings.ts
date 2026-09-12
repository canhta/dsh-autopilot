import { isDeepStrictEqual } from 'node:util'
import s from '@deepseek-ai/schemastery'
import { CodeHostProviderError, codeHostBindingId, codeHostRepositoryId } from '../../code-host.js'

export interface GitHubCodeHostSettings {
  mcpServerName: string
  repositoryOwner: string
  repositoryName: string
  repositoryId: string
  bindingId: string
  integrationActorId: string
  pageSize: number
  maxPagesPerTraversal: number
}

const protectedSettingKeys = [
  'mcpServerName',
  'repositoryOwner',
  'repositoryName',
  'repositoryId',
  'bindingId',
  'integrationActorId',
] as const satisfies readonly (keyof GitHubCodeHostSettings)[]

/** Whether a Settings edit would retarget an allocated GitHub publication. */
export function changesGitHubCodeHostBinding(current: GitHubCodeHostSettings, next: GitHubCodeHostSettings): boolean {
  return protectedSettingKeys.some((key) => !isDeepStrictEqual(current[key], next[key]))
}

export const githubCodeHostSettingsSchema: s<GitHubCodeHostSettings> = s.object({
  mcpServerName: s.string().default('github'),
  repositoryOwner: s.string().default(''),
  repositoryName: s.string().default(''),
  repositoryId: s.string().default(''),
  bindingId: s.string().default(''),
  integrationActorId: s.string().default(''),
  pageSize: s.number().min(1).max(100).default(100),
  maxPagesPerTraversal: s.number().min(1).max(100).default(20),
})

export function validateStoredSettings(config: GitHubCodeHostSettings): void {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(config.mcpServerName)) throw new TypeError('GitHub MCP server name is invalid')
  validateRepositoryPart(config.repositoryOwner, 'owner')
  validateRepositoryPart(config.repositoryName, 'name')
  if (config.repositoryId !== '') codeHostRepositoryId(config.repositoryId)
  if (config.bindingId !== '') codeHostBindingId(config.bindingId)
  if (config.integrationActorId !== '' && !/^[1-9][0-9]{0,19}$/.test(config.integrationActorId)) {
    throw new TypeError('GitHub integration actor id is invalid')
  }
  if (!Number.isInteger(config.pageSize) || config.pageSize < 1 || config.pageSize > 100) {
    throw new TypeError('GitHub code-host page size must be an integer from 1 through 100')
  }
  if (
    !Number.isInteger(config.maxPagesPerTraversal) ||
    config.maxPagesPerTraversal < 1 ||
    config.maxPagesPerTraversal > 100
  ) {
    throw new TypeError('GitHub code-host maximum pages must be an integer from 1 through 100')
  }
}

export function requireConfiguredSettings(config: GitHubCodeHostSettings): GitHubCodeHostSettings {
  const missing = ['repositoryOwner', 'repositoryName', 'repositoryId', 'bindingId', 'integrationActorId'].filter(
    (field) => config[field as keyof GitHubCodeHostSettings] === '',
  )
  if (missing.length > 0) {
    throw new CodeHostProviderError(
      'invalid-configuration',
      `GitHub code-host settings are incomplete: ${missing.join(', ')}`,
    )
  }
  try {
    validateStoredSettings(config)
  } catch {
    throw new CodeHostProviderError('invalid-configuration', 'GitHub code-host settings are invalid')
  }
  return config
}

function validateRepositoryPart(value: string, part: string): void {
  if (value !== '' && (value.length > 100 || value === '.' || value === '..' || !/^[A-Za-z0-9_.-]+$/.test(value))) {
    throw new TypeError(`GitHub repository ${part} is invalid`)
  }
}
