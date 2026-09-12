// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.js'
import { en } from '../src/client/locales/index.js'
import type { AutopilotSettings } from '../src/config.js'
import { mutableConnection, remoteFixture } from './web-fixtures.js'

describe('Autopilot client slot lifecycle', () => {
  it('waits for shell declarations, remounts after a shell cycle, and fully withdraws on unload', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeSlots)
    const connection = mutableConnection()
    const settings = settingsScope()
    const unmountRemote = vi.fn()
    const remoteApi = remoteFixture()
    const mountRemote = vi.fn(async () => {
      const remoteService = ctx.plugin({
        name: 'fixture-autopilot-remote',
        apply: (remoteContext: Context) => {
          remoteContext.provide('remote.autopilot', remoteApi)
        },
      })
      await remoteService.await()
      return async () => {
        unmountRemote()
        await remoteService.dispose()
      }
    })
    const localeDispose = vi.fn()

    ctx.provide('connection', connection.handle)
    ctx.provide('layout', {})
    ctx.provide('remote', { autopilot: remoteApi, $mount: mountRemote })
    ctx.provide('settingsScope', { bind: vi.fn(() => settings) })
    ctx.provide('locale', {
      register: vi.fn(() => localeDispose),
      bind: vi.fn(() => (key: keyof typeof en) => en[key]),
    })

    const client = ctx.plugin({ name: 'autopilot-client-test', inject: [...inject], apply })
    await client.await()
    expect(entries(ctx, 'main')).toEqual([])
    expect(entries(ctx, 'sidebar.panellist')).toEqual([])
    expect(entries(ctx, 'settings.section')).toEqual([])

    const firstShell = ctx.get('slots')?.declareShell()
    if (firstShell === undefined) throw new Error('slots service unavailable')
    expect(keys(ctx, 'main')).toEqual(['autopilot-operations'])
    expect(ids(ctx, 'sidebar.panellist')).toEqual(['autopilot-operations'])
    expect(ids(ctx, 'settings.section')).toEqual(['autopilot-settings'])
    const sidebarIcon = entries(ctx, 'sidebar.panellist')[0]?.component
    if (typeof sidebarIcon !== 'function') throw new Error('sidebar icon contribution unavailable')
    expect(sidebarIcon({ size: 16, active: true })).toBeNull()
    expect(sidebarIcon({ size: 18, active: true })).not.toBeNull()

    firstShell()
    expect(entries(ctx, 'main')).toEqual([])
    expect(entries(ctx, 'sidebar.panellist')).toEqual([])
    expect(entries(ctx, 'settings.section')).toEqual([])

    const secondShell = ctx.get('slots')?.declareShell()
    if (secondShell === undefined) throw new Error('slots service unavailable')
    expect(keys(ctx, 'main')).toEqual(['autopilot-operations'])
    expect(ids(ctx, 'sidebar.panellist')).toEqual(['autopilot-operations'])
    expect(ids(ctx, 'settings.section')).toEqual(['autopilot-settings'])

    await client.dispose()
    expect(entries(ctx, 'main')).toEqual([])
    expect(entries(ctx, 'sidebar.panellist')).toEqual([])
    expect(entries(ctx, 'settings.section')).toEqual([])
    expect(mountRemote).toHaveBeenCalledOnce()
    expect(unmountRemote).toHaveBeenCalledOnce()
    expect(localeDispose).toHaveBeenCalledOnce()
    secondShell()
  })
})

interface SlotEntry {
  options: { id?: string; key?: string }
  component: unknown
}

interface ErasedSlots {
  entries(name: string): ReadonlyArray<SlotEntry>
}

function erased(ctx: Context): ErasedSlots {
  return ctx.slots as unknown as ErasedSlots
}

function entries(ctx: Context, name: string) {
  return erased(ctx).entries(name)
}

function ids(ctx: Context, name: string) {
  return entries(ctx, name).map((entry) => entry.options.id)
}

function keys(ctx: Context, name: string) {
  return entries(ctx, name).map((entry) => entry.options.key)
}

class FakeSlots extends Service {
  private readonly declared = new Set<string>()
  private readonly contributions = new Map<string, SlotEntry[]>()
  private readonly waiters = new Map<string, Set<{ setup: () => () => void; active?: () => void }>>()

  constructor(ctx: Context) {
    super(ctx, 'slots', true)
  }

  entries(name: string): readonly SlotEntry[] {
    return this.contributions.get(name) ?? []
  }

  inject(name: string, setup: () => () => void): () => void {
    const waiter: { setup: () => () => void; active?: () => void } = { setup }
    const set = this.waiters.get(name) ?? new Set()
    set.add(waiter)
    this.waiters.set(name, set)
    if (this.declared.has(name)) waiter.active = setup()
    return this.ctx.effect(() => () => {
      waiter.active?.()
      set.delete(waiter)
    })
  }

  register(options: { name: string; id?: string; key?: string }, component: unknown): () => void {
    const entries = this.contributions.get(options.name) ?? []
    const entry = { options, component }
    entries.push(entry)
    this.contributions.set(options.name, entries)
    return () => {
      const index = entries.indexOf(entry)
      if (index >= 0) entries.splice(index, 1)
    }
  }

  declareShell(): () => void {
    const names = ['main', 'sidebar.panellist', 'settings.section']
    for (const name of names) {
      this.declared.add(name)
      for (const waiter of this.waiters.get(name) ?? []) waiter.active = waiter.setup()
    }
    return () => {
      for (const name of names) {
        this.declared.delete(name)
        for (const waiter of this.waiters.get(name) ?? []) {
          waiter.active?.()
          waiter.active = undefined
        }
      }
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: FakeSlots
  }

  interface Services {
    slots: FakeSlots
  }
}

function settingsScope(): SettingsScope<AutopilotSettings> {
  const value: AutopilotSettings = {
    trackerProvider: 'external',
    maxQueued: 20,
    maxRunning: 2,
    maxBriefBytes: 32_768,
    reconcileIntervalSeconds: 300,
    executionMode: 'disabled',
    targetRepository: '',
    targetBaseBranch: '',
    managedWorktreeRoot: '',
    deploymentTokenCap: 100_000,
    perRunTokenCap: 50_000,
    runTokenAllowance: 40_000,
  }
  const store = createSnapshotStore<SettingsScopeSnapshot<AutopilotSettings>>({
    status: 'ready',
    value,
    base: {},
    user: {},
    revision: 1,
    writable: true,
    mode: 'host',
  })
  return { ...store, mutate: vi.fn(), set: vi.fn(), unset: vi.fn() }
}
