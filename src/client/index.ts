import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { IconGaugeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement } from 'react'
import type { AutopilotSettings } from '../config.js'
import remoteContribution from '../remote.js'
import { en, zh } from './locales/index.js'
import { OperationsPanel, type OperationsPanelInjected } from './OperationsPanel.js'
import { type AutopilotSettingsInjected, AutopilotSettingsPanel } from './SettingsPanel.js'
import { OperationsController } from './state.js'

export { OperationsPanel } from './OperationsPanel.js'
export { AutopilotSettingsPanel } from './SettingsPanel.js'
export type { OperationsClientState, QueryState } from './state.js'
export { OperationsController } from './state.js'

export const NS = 'autopilot'
export const inject = ['slots', 'locale', 'layout', 'remote', 'settingsScope', 'connection']

/** Mount the generated Remote contribution and register Autopilot in DSH main/sidebar/Settings slots. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(remoteContribution)
  const contribution = ctx.plugin({
    name: 'dsh-autopilot-ui',
    inject: [...inject, 'remote.autopilot'],
    apply: applyContribution,
  })
  try {
    await contribution.await()
  } catch (error) {
    await disposeRemote()
    throw error
  }
  return async () => {
    await contribution.dispose()
    await disposeRemote()
  }
}

function applyContribution(ctx: Context): () => void {
  const connection = ctx.get('connection') as ConnectionHandle
  const controller = new OperationsController(ctx.remote.autopilot, connection, (listener) =>
    ctx.on('connection/reset', listener),
  )
  const scope: SettingsScope<AutopilotSettings> = ctx.settingsScope.bind({
    namespace: 'dsh-autopilot',
    decode: decodeSettings,
  })
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-autopilot: dictionaries')
  const t = ctx.locale.bind(NS)
  const panelInjected = (): OperationsPanelInjected => ({
    actions: {
      connect: () => controller.connect(),
      inspectWorktree: (runId, signal) => controller.inspectWorktree(runId, signal),
      loadRun: (runId, signal) => controller.loadRun(runId, signal),
      previewCleanup: (runId, signal) => controller.previewCleanup(runId, signal),
      refresh: () => controller.refresh(),
      runCommand: (kind, target) => controller.runCommand(kind, target),
      setQuery: (patch) => controller.setQuery(patch),
    },
    hooks: { operations: controller.store },
  })
  const settingsInjected = (): AutopilotSettingsInjected => ({
    actions: {
      connect: () => controller.connect(),
      save: (ops, revision) => scope.mutate(ops, revision),
      testProvider: (providerId, signal) => controller.testProvider(providerId, signal),
      describeCredentials: async (refs) => unwrap(await ctx.remote.credentials.describe([...refs])),
      setCredential: async (ref, value) => unwrap(await ctx.remote.credentials.set(ref, value)),
      unsetCredential: async (ref) => unwrap(await ctx.remote.credentials.unset(ref)),
      openSettingsDocument: async (signal) => {
        unwrap(await ctx.remote.settings.openSettingsDocument(signal))
      },
    },
    hooks: { settings: scope, operations: controller.store },
  })

  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: 'autopilot-operations',
        locale: NS,
        inject: panelInjected,
      },
      OperationsPanel,
    ),
  )
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: 'autopilot-operations',
        order: 40,
        label: () => t('panelNav'),
        locale: NS,
      },
      OperationsIcon,
    ),
  )
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'autopilot-settings',
        order: 40,
        label: () => t('settingsNav'),
        locale: NS,
        inject: settingsInjected,
      },
      AutopilotSettingsPanel,
    ),
  )

  return () => {
    controller.dispose()
  }
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (result.ok) return result.value
  throw new Error(`${result.error.code}: ${result.error.message}`)
}

function OperationsIcon({ size }: PropsRuntime<'sidebar.panellist'> & PropsLocale<'autopilot'>) {
  if (size < 18) return null
  return createElement('span', { 'aria-hidden': 'true' }, createElement(IconGaugeOutline16, { size }))
}

function decodeSettings(value: unknown): AutopilotSettings | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Partial<AutopilotSettings>
  return typeof candidate.trackerProvider === 'string' &&
    typeof candidate.maxQueued === 'number' &&
    typeof candidate.maxRunning === 'number' &&
    typeof candidate.maxBriefBytes === 'number' &&
    typeof candidate.reconcileIntervalSeconds === 'number' &&
    (candidate.executionMode === 'disabled' || candidate.executionMode === 'native') &&
    typeof candidate.targetRepository === 'string' &&
    typeof candidate.targetBaseBranch === 'string' &&
    typeof candidate.managedWorktreeRoot === 'string' &&
    typeof candidate.deploymentTokenCap === 'number' &&
    typeof candidate.perRunTokenCap === 'number' &&
    typeof candidate.runTokenAllowance === 'number'
    ? (candidate as AutopilotSettings)
    : undefined
}
