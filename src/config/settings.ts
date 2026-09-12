import { isAbsolute } from 'node:path'
import { type Context, Service } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import s from '@deepseek-ai/schemastery'
import { codeHostProviderId } from '../code-host.js'
import { type NotificationEvent, notificationDestinationId, notificationProviderId } from '../notification.js'
import { trackerProviderId } from '../tracker.js'

export interface NotificationSubscription {
  providerId: string
  destinationId: string
  events: NotificationEvent['type'][]
  summaryDisclosure: 'redacted' | 'full'
}

export interface AutopilotSettings {
  trackerProvider: string
  codeHostProvider: string
  allowWorkflowChanges: boolean
  notificationSubscriptions: NotificationSubscription[]
  runUrlTemplate: string
  issueUrlTemplate: string
  maxQueued: number
  maxRunning: number
  maxBriefBytes: number
  reconcileIntervalSeconds: number
  executionMode: 'disabled' | 'native'
  targetRepository: string
  targetBaseBranch: string
  managedWorktreeRoot: string
  runtimeStorePath: string
  autoCleanupEnabled: boolean
  cleanupRetentionDays: number
  deploymentTokenCap: number
  perRunTokenCap: number
  runTokenAllowance: number
}

const autopilotSettingsSchema: s<AutopilotSettings> = s.object({
  trackerProvider: s.string().default('jira'),
  codeHostProvider: s.string().default(''),
  allowWorkflowChanges: s.boolean().default(false),
  notificationSubscriptions: s
    .array(
      s.object({
        providerId: s.string().required(),
        destinationId: s.string().required(),
        events: s.array(s.union(['started', 'blocked', 'paused', 'failed', 'completed'] as const)).default([]),
        summaryDisclosure: s.union(['redacted', 'full'] as const).default('redacted'),
      }),
    )
    .default([]),
  runUrlTemplate: s.string().default(''),
  issueUrlTemplate: s.string().default(''),
  maxQueued: s.number().min(1).max(100).default(20),
  maxRunning: s.number().min(1).max(100).default(1),
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
  executionMode: s.union(['disabled', 'native'] as const).default('disabled'),
  targetRepository: s.string().default(''),
  targetBaseBranch: s.string().default(''),
  managedWorktreeRoot: s.string().default(''),
  runtimeStorePath: s.string().default(''),
  autoCleanupEnabled: s.boolean().default(true),
  cleanupRetentionDays: s.number().min(0).max(3650).default(7),
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
  private settings?: SettingsScope<AutopilotSettings>

  constructor(ctx: Context) {
    super(ctx, 'autopilotConfig')
    this.settings = ctx.settings.register('dsh-autopilot', autopilotSettingsSchema, {
      validate: (value) => {
        validateSettings(value)
        const current = this.settings?.get()
        if (current === undefined) return
        if (current.trackerProvider !== value.trackerProvider) {
          const admission = ctx.get('admission')
          if (admission === undefined) {
            throw new Error('Cannot change tracker provider because durable run status is unavailable.')
          }
          const blocker = admission.trackerSwitchBlocker(current.trackerProvider)
          if (blocker !== undefined) throw new Error(blocker)
        }
        if (current.codeHostProvider !== value.codeHostProvider) {
          const admission = ctx.get('admission')
          if (admission === undefined) {
            throw new Error('Cannot change code-host provider because durable run status is unavailable.')
          }
          const blocker = admission.codeHostSwitchBlocker(current.codeHostProvider)
          if (blocker !== undefined) throw new Error(blocker)
        }
        if (
          current.targetRepository !== value.targetRepository ||
          current.targetBaseBranch !== value.targetBaseBranch ||
          current.managedWorktreeRoot !== value.managedWorktreeRoot ||
          current.allowWorkflowChanges !== value.allowWorkflowChanges
        ) {
          const admission = ctx.get('admission')
          if (admission === undefined) {
            throw new Error('Cannot change execution routing because durable run status is unavailable.')
          }
          const blocker = admission.executionRoutingSwitchBlocker()
          if (blocker !== undefined) throw new Error(blocker)
        }
      },
    })
  }

  /** Return the current validated Settings snapshot; the caller receives no credential values and performs no I/O. */
  get(): AutopilotSettings {
    if (this.settings === undefined) throw new Error('Autopilot Settings are not initialized')
    return this.settings.get()
  }

  /**
   * Observe successfully persisted Settings changes until the returned disposer is called.
   * The Settings service serializes callbacks; callback failures propagate according to its watcher contract.
   */
  watch(callback: (next: AutopilotSettings, previous: AutopilotSettings) => void | Promise<void>): () => void {
    if (this.settings === undefined) throw new Error('Autopilot Settings are not initialized')
    return this.settings.watch(callback)
  }
}

function validateSettings(value: AutopilotSettings): void {
  trackerProviderId(value.trackerProvider)
  if (value.codeHostProvider !== '') codeHostProviderId(value.codeHostProvider)
  if (value.notificationSubscriptions.length > 32) throw new TypeError('too many notification subscriptions')
  const notificationKeys = new Set<string>()
  for (const subscription of value.notificationSubscriptions) {
    notificationProviderId(subscription.providerId)
    notificationDestinationId(subscription.destinationId)
    if (subscription.events.length === 0 || new Set(subscription.events).size !== subscription.events.length) {
      throw new TypeError('notification events must be non-empty and unique')
    }
    const key = `${subscription.providerId}\0${subscription.destinationId}`
    if (notificationKeys.has(key)) throw new TypeError('notification destinations must be unique')
    notificationKeys.add(key)
  }
  if (value.notificationSubscriptions.length > 0) {
    validateUrlTemplate(value.runUrlTemplate, '{runId}', 'run URL')
    validateUrlTemplate(value.issueUrlTemplate, '{displayKey}', 'issue URL')
  }
  if (value.runtimeStorePath !== '' && !isAbsolute(value.runtimeStorePath)) {
    throw new TypeError('runtimeStorePath must be an absolute path')
  }
  for (const [name, candidate] of [
    ['maxQueued', value.maxQueued],
    ['maxRunning', value.maxRunning],
    ['maxBriefBytes', value.maxBriefBytes],
    ['reconcileIntervalSeconds', value.reconcileIntervalSeconds],
    ['cleanupRetentionDays', value.cleanupRetentionDays],
    ['deploymentTokenCap', value.deploymentTokenCap],
    ['perRunTokenCap', value.perRunTokenCap],
    ['runTokenAllowance', value.runTokenAllowance],
  ] as const) {
    if (!Number.isInteger(candidate)) throw new TypeError(`${name} must be an integer`)
  }
  if (value.executionMode === 'native') validateExecutionSettings(value)
}

function validateUrlTemplate(template: string, placeholder: string, subject: string): void {
  if (template.length > 4096) throw new TypeError(`${subject} template is too long`)
  if (template.split(placeholder).length !== 2)
    throw new TypeError(`${subject} template must contain ${placeholder} once`)
  let url: URL
  try {
    url = new URL(template.replace(placeholder, 'validated-id'))
  } catch {
    throw new TypeError(`${subject} template must produce an absolute URL`)
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new TypeError(`${subject} template must use HTTPS without embedded credentials`)
  }
}

/** Validate execution routing and budget settings before any resource is acquired. */
export function validateExecutionSettings(settings: AutopilotSettings): void {
  if (settings.executionMode !== 'native') {
    throw new Error('dispatch is disabled; enable native execution first')
  }
  if (!isAbsolute(settings.targetRepository) || !isAbsolute(settings.managedWorktreeRoot)) {
    throw new TypeError('target repository and managed worktree root must be absolute paths')
  }
  if (settings.codeHostProvider === '') throw new TypeError('codeHostProvider is required for execution')
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(settings.targetBaseBranch) ||
    settings.targetBaseBranch.includes('..') ||
    settings.targetBaseBranch.includes('//') ||
    settings.targetBaseBranch.endsWith('/') ||
    settings.targetBaseBranch.endsWith('.lock')
  ) {
    throw new TypeError('target base branch is invalid')
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
