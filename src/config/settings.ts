import { isAbsolute } from 'node:path'
import { type Context, Service } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import s from '@deepseek-ai/schemastery'
import { trackerProviderId } from '../tracker.js'

export interface AutopilotSettings {
  trackerProvider: string
  maxQueued: number
  maxBriefBytes: number
  reconcileIntervalSeconds: number
  executionMode: 'disabled' | 'fixture'
  targetRepository: string
  targetBaseBranch: string
  managedWorktreeRoot: string
  deploymentTokenCap: number
  perRunTokenCap: number
  runTokenAllowance: number
}

const autopilotSettingsSchema: s<AutopilotSettings> = s.object({
  trackerProvider: s.string().default('jira'),
  maxQueued: s.number().min(1).max(100).default(20),
  maxBriefBytes: s
    .number()
    .min(1024)
    .max(32 * 1024)
    .default(32 * 1024),
  reconcileIntervalSeconds: s
    .number()
    .min(5)
    .max(24 * 60 * 60)
    .default(5 * 60),
  executionMode: s.union(['disabled', 'fixture'] as const).default('disabled'),
  targetRepository: s.string().default(''),
  targetBaseBranch: s.string().default(''),
  managedWorktreeRoot: s.string().default(''),
  deploymentTokenCap: s.number().min(0).default(0),
  perRunTokenCap: s.number().min(0).default(0),
  runTokenAllowance: s.number().min(0).default(0),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    autopilotConfig: AutopilotConfig
  }
}

/** Own and validate the one root Autopilot Settings namespace. */
export class AutopilotConfig extends Service {
  static readonly inject = ['settings']
  private readonly settings: SettingsScope<AutopilotSettings>

  constructor(ctx: Context) {
    super(ctx, 'autopilotConfig')
    this.settings = ctx.settings.register('dsh-autopilot', autopilotSettingsSchema, {
      validate: validateSettings,
    })
  }

  get(): AutopilotSettings {
    return this.settings.get()
  }

  watch(callback: (next: AutopilotSettings, previous: AutopilotSettings) => void | Promise<void>): () => void {
    return this.settings.watch(callback)
  }
}

function validateSettings(value: AutopilotSettings): void {
  trackerProviderId(value.trackerProvider)
  for (const [name, candidate] of [
    ['maxQueued', value.maxQueued],
    ['maxBriefBytes', value.maxBriefBytes],
    ['reconcileIntervalSeconds', value.reconcileIntervalSeconds],
    ['deploymentTokenCap', value.deploymentTokenCap],
    ['perRunTokenCap', value.perRunTokenCap],
    ['runTokenAllowance', value.runTokenAllowance],
  ] as const) {
    if (!Number.isInteger(candidate)) throw new TypeError(`${name} must be an integer`)
  }
  if (value.executionMode === 'fixture') validateFixtureExecutionSettings(value)
}

export function validateFixtureExecutionSettings(settings: AutopilotSettings): void {
  if (settings.executionMode !== 'fixture') {
    throw new Error('dispatch is disabled; this slice accepts only explicit fixture execution')
  }
  if (!isAbsolute(settings.targetRepository) || !isAbsolute(settings.managedWorktreeRoot)) {
    throw new TypeError('fixture target repository and managed worktree root must be absolute paths')
  }
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(settings.targetBaseBranch) ||
    settings.targetBaseBranch.includes('..') ||
    settings.targetBaseBranch.includes('//') ||
    settings.targetBaseBranch.endsWith('/') ||
    settings.targetBaseBranch.endsWith('.lock')
  ) {
    throw new TypeError('fixture target base branch is invalid')
  }
  for (const [name, value] of [
    ['deploymentTokenCap', settings.deploymentTokenCap],
    ['perRunTokenCap', settings.perRunTokenCap],
    ['runTokenAllowance', settings.runTokenAllowance],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`)
  }
  if (settings.runTokenAllowance > settings.perRunTokenCap) {
    throw new TypeError('run token allowance must not exceed the per-run token cap')
  }
  if (settings.runTokenAllowance > settings.deploymentTokenCap) {
    throw new TypeError('run token allowance must not exceed the deployment token cap')
  }
}

export default AutopilotConfig
