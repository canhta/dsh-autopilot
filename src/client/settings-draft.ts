import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AutopilotSettings, NotificationSubscription } from '../config.js'
import type {} from './locales/index.js'

export interface SettingsDraft {
  trackerProvider: string
  codeHostProvider: string
  allowWorkflowChanges: boolean
  notificationSubscriptions: NotificationSubscriptionDraft[]
  runUrlTemplate: string
  issueUrlTemplate: string
  maxQueued: string
  maxRunning: string
  maxBriefBytes: string
  reconcileIntervalSeconds: string
  executionMode: 'disabled' | 'native'
  targetRepository: string
  targetBaseBranch: string
  managedWorktreeRoot: string
  autoCleanupEnabled: boolean
  cleanupRetentionDays: string
  deploymentTokenCap: string
  perRunTokenCap: string
  runTokenAllowance: string
}
export interface NotificationSubscriptionDraft extends NotificationSubscription {
  readonly draftId: string
}
export type AutopilotTranslate = PropsLocale<'autopilot'>['t']

export function toSettingsDraft(value: AutopilotSettings): SettingsDraft {
  return {
    trackerProvider: value.trackerProvider,
    codeHostProvider: value.codeHostProvider,
    allowWorkflowChanges: value.allowWorkflowChanges,
    notificationSubscriptions: value.notificationSubscriptions.map((subscription, index) => ({
      ...structuredClone(subscription),
      draftId: `stored:${String(index)}:${subscription.providerId}:${subscription.destinationId}`,
    })),
    runUrlTemplate: value.runUrlTemplate,
    issueUrlTemplate: value.issueUrlTemplate,
    maxQueued: String(value.maxQueued),
    maxRunning: String(value.maxRunning),
    maxBriefBytes: String(value.maxBriefBytes),
    reconcileIntervalSeconds: String(value.reconcileIntervalSeconds),
    executionMode: value.executionMode,
    targetRepository: value.targetRepository,
    targetBaseBranch: value.targetBaseBranch,
    managedWorktreeRoot: value.managedWorktreeRoot,
    autoCleanupEnabled: value.autoCleanupEnabled,
    cleanupRetentionDays: String(value.cleanupRetentionDays),
    deploymentTokenCap: String(value.deploymentTokenCap),
    perRunTokenCap: String(value.perRunTokenCap),
    runTokenAllowance: String(value.runTokenAllowance),
  }
}

export function parseSettingsDraft(draft: SettingsDraft, current: AutopilotSettings): AutopilotSettings | undefined {
  const maxQueued = integer(draft.maxQueued, 1, 100)
  const maxRunning = integer(draft.maxRunning, 1, 100)
  const maxBriefBytes = integer(draft.maxBriefBytes, 1024, 32768)
  const reconcileIntervalSeconds = integer(draft.reconcileIntervalSeconds, 5, 86400)
  const deploymentTokenCap = integer(draft.deploymentTokenCap, 0)
  const perRunTokenCap = integer(draft.perRunTokenCap, 0)
  const runTokenAllowance = integer(draft.runTokenAllowance, 0)
  const cleanupRetentionDays = integer(draft.cleanupRetentionDays, 0, 3650)
  if (
    maxQueued === undefined ||
    maxRunning === undefined ||
    maxBriefBytes === undefined ||
    reconcileIntervalSeconds === undefined ||
    deploymentTokenCap === undefined ||
    perRunTokenCap === undefined ||
    runTokenAllowance === undefined ||
    cleanupRetentionDays === undefined ||
    !validSubscriptions(draft.notificationSubscriptions)
  )
    return undefined
  if (runTokenAllowance > perRunTokenCap || runTokenAllowance > deploymentTokenCap) return undefined
  return {
    ...current,
    trackerProvider: draft.trackerProvider,
    codeHostProvider: draft.codeHostProvider,
    allowWorkflowChanges: draft.allowWorkflowChanges,
    notificationSubscriptions: draft.notificationSubscriptions.map(({ draftId: _, ...subscription }) =>
      structuredClone(subscription),
    ),
    runUrlTemplate: draft.runUrlTemplate,
    issueUrlTemplate: draft.issueUrlTemplate,
    maxQueued,
    maxRunning,
    maxBriefBytes,
    reconcileIntervalSeconds,
    executionMode: draft.executionMode,
    targetRepository: draft.targetRepository,
    targetBaseBranch: draft.targetBaseBranch,
    managedWorktreeRoot: draft.managedWorktreeRoot,
    autoCleanupEnabled: draft.autoCleanupEnabled,
    cleanupRetentionDays,
    deploymentTokenCap,
    perRunTokenCap,
    runTokenAllowance,
  }
}

function validSubscriptions(subscriptions: readonly NotificationSubscription[]): boolean {
  if (subscriptions.length > 32) return false
  const identities = subscriptions.map(({ providerId, destinationId }) => `${providerId}\0${destinationId}`)
  return (
    new Set(identities).size === identities.length &&
    subscriptions.every(
      ({ providerId, destinationId, events }) =>
        providerId !== '' && destinationId !== '' && events.length > 0 && new Set(events).size === events.length,
    )
  )
}

function integer(value: string, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined
}
