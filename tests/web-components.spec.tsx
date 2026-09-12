// @vitest-environment jsdom

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '../src/client/locales/index.js'
import { OperationsPanel } from '../src/client/OperationsPanel.js'
import { AutopilotSettingsPanel } from '../src/client/SettingsPanel.js'
import { OperationsController } from '../src/client/state.js'
import type { AutopilotSettings } from '../src/config.js'
import { mutableConnection, operationsFixture, remoteFixture, runDetailFixture } from './web-fixtures.js'

afterEach(cleanup)
const t = (key: keyof typeof en, params?: Record<string, string | number>) => {
  let value: string = en[key]
  for (const [name, replacement] of Object.entries(params ?? {}))
    value = value.replaceAll(`{${name}}`, String(replacement))
  return value
}

describe('Autopilot Web components', () => {
  it('keeps a blocked external-provider run readable and offers no Web authorization bypass', async () => {
    const connection = mutableConnection()
    const snapshot = operationsFixture()
    const run = snapshot.runs.items[0]
    if (run === undefined) throw new Error('expected run fixture')
    run.actions = ['cancel-run']
    const command = vi.fn(remoteFixture().command)
    const controller = new OperationsController(
      { ...remoteFixture(snapshot, runDetailFixture({ actions: ['cancel-run'] })), command },
      connection.handle,
      connection.subscribeReset,
    )
    render(
      <OperationsPanel actions={operationsActions(controller)} useOperations={selectorHook(controller.store)} t={t} />,
    )

    expect(await screen.findByRole('heading', { name: 'Autopilot' })).toBeTruthy()
    expect(screen.getAllByRole('tab')).toHaveLength(5)
    const runsTab = screen.getByRole('tab', { name: 'Queue & Runs' })
    runsTab.focus()
    fireEvent.keyDown(runsTab, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Schedule' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(runsTab)
    fireEvent.click(screen.getByRole('button', { name: /EXT-42/ }))
    expect(await screen.findByText('Waiting for a human in External tracker')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /authorize|approve/i })).toBeNull()
    expect(screen.getByText('PR integration pending.')).toBeTruthy()
    expect(screen.getByRole('option', { name: 'cancelled' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }))
    await waitFor(() => {
      expect(command).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'cancel-run', runId: run.runId }),
        expect.any(AbortSignal),
      )
    })

    fireEvent.click(screen.getByRole('tab', { name: 'Notifications' }))
    expect(screen.getByText('No fixture delivery contribution.')).toBeTruthy()
  })

  it('preserves the last snapshot while disconnected, disables mutations, and refetches on reset', async () => {
    const connection = mutableConnection()
    const operations = vi.fn(remoteFixture().operations)
    const command = vi.fn(remoteFixture().command)
    const controller = new OperationsController(
      { ...remoteFixture(), operations, command },
      connection.handle,
      connection.subscribeReset,
    )
    render(
      <OperationsPanel actions={operationsActions(controller)} useOperations={selectorHook(controller.store)} t={t} />,
    )
    await screen.findByText('EXT-42')
    expect(operations).toHaveBeenCalledOnce()

    act(() => {
      connection.set('disconnected')
    })
    expect(screen.getByText('Disconnected')).toBeTruthy()
    expect(screen.getByText('EXT-42')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Pause' }) as HTMLButtonElement).disabled).toBe(true)

    act(() => {
      connection.set('connected')
      connection.reset()
    })
    await waitFor(() => {
      expect(operations).toHaveBeenCalledTimes(2)
    })
    expect(command).not.toHaveBeenCalled()
  })

  it('pages the shared run query so notification and worktree records beyond the first page remain reachable', async () => {
    const connection = mutableConnection()
    const snapshot = operationsFixture()
    snapshot.runs = { ...snapshot.runs, total: 101, offset: 50, limit: 50 }
    const controller = new OperationsController(remoteFixture(snapshot), connection.handle, connection.subscribeReset)
    render(
      <OperationsPanel actions={operationsActions(controller)} useOperations={selectorHook(controller.store)} t={t} />,
    )

    expect(await screen.findByText('Page 2 of 3')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(controller.store.getSnapshot().query.offset).toBe(100)
    controller.dispose()
  })

  it('reconciles an ambiguous command delivery with the same caller request id', async () => {
    const connection = mutableConnection()
    const requestIds: string[] = []
    const command = vi.fn(async (request: Parameters<ReturnType<typeof remoteFixture>['command']>[0]) => {
      requestIds.push(request.requestId)
      if (requestIds.length === 1) throw new Error('connection reset after Host acceptance')
      return {
        ok: true as const,
        value: {
          requestId: request.requestId,
          kind: request.kind,
          status: 'accepted' as const,
          acceptedAt: '2026-09-12T00:00:00.000Z',
        },
      }
    })
    let statusReads = 0
    const commandStatus = vi.fn(async (requestId: string) => {
      statusReads += 1
      if (statusReads === 1) throw new Error('transient status delivery failure')
      return statusReads === 2
        ? { ok: true as const, value: null }
        : {
            ok: true as const,
            value: {
              requestId,
              kind: 'reconcile' as const,
              status: 'succeeded' as const,
              acceptedAt: '2026-09-12T00:00:00.000Z',
              finishedAt: '2026-09-12T00:00:01.000Z',
            },
          }
    })
    const controller = new OperationsController(
      { ...remoteFixture(), command, commandStatus },
      connection.handle,
      connection.subscribeReset,
    )

    const running = controller.runCommand('reconcile')
    await waitFor(() => expect(controller.store.getSnapshot().command).toMatchObject({ status: 'pending' }))
    await running
    await waitFor(() => expect(controller.store.getSnapshot().command).toMatchObject({ status: 'succeeded' }))
    expect(requestIds).toHaveLength(2)
    expect(new Set(requestIds).size).toBe(1)
    controller.dispose()
  })

  it('aborts selected-run Remote reads when the Client contribution is disposed', async () => {
    const connection = mutableConnection()
    const run = vi.fn(
      (_runId: string, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    const controller = new OperationsController(
      { ...remoteFixture(), run },
      connection.handle,
      connection.subscribeReset,
    )

    const read = controller.loadRun('run_fixture')
    controller.dispose()
    await expect(read).rejects.toThrow(/disposed/i)
  })

  it('inspects a worktree without authorization, then targets removal with its explicit preview', async () => {
    const connection = mutableConnection()
    const snapshot = operationsFixture()
    const run = snapshot.runs.items[0]
    if (run === undefined) throw new Error('expected run fixture')
    run.worktree = {
      path: '/tmp/autopilot/run_fixture',
      branch: 'autopilot/ext-42',
      state: 'unknown',
      dirty: { status: 'unknown', reason: 'Not inspected.' },
      untracked: { status: 'unknown', reason: 'Not inspected.' },
      unpushed: { status: 'unknown', reason: 'Not inspected.' },
      pullRequestDisposition: 'unknown',
      cleanup: { status: 'unavailable', reason: 'Not inspected.' },
    }
    snapshot.integrations.worktrees = { status: 'available' }
    const inspected = {
      ...run.worktree,
      state: 'cleanup-eligible' as const,
      dirty: { status: 'known' as const, value: false },
      untracked: { status: 'known' as const, value: false },
      unpushed: { status: 'known' as const, value: false },
      pullRequestDisposition: 'merged' as const,
      cleanup: { status: 'available' as const, eligible: true, rejections: [], removableBytes: 1024 },
    }
    const worktree = vi.fn(async () => ({ ok: true as const, value: inspected }))
    const previewCleanup = vi.fn(async () => ({
      ok: true as const,
      value: { ...inspected, previewId: 'fdedaf6b-ee84-4427-8861-81fd3c021380' },
    }))
    const command = vi.fn(remoteFixture().command)
    const controller = new OperationsController(
      { ...remoteFixture(snapshot), worktree, previewCleanup, command },
      connection.handle,
      connection.subscribeReset,
    )
    render(
      <OperationsPanel actions={operationsActions(controller)} useOperations={selectorHook(controller.store)} t={t} />,
    )

    fireEvent.click(await screen.findByRole('tab', { name: 'Worktrees' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Preview cleanup' }))
    expect(previewCleanup).toHaveBeenCalledWith(run.runId, expect.any(AbortSignal))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove worktree' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'remove-worktree',
          previewId: 'fdedaf6b-ee84-4427-8861-81fd3c021380',
        }),
        expect.any(AbortSignal),
      ),
    )
    expect(worktree).toHaveBeenCalled()
    controller.dispose()
  })

  it('saves one revision-fenced settings draft and reports a stale-write recovery', async () => {
    const connection = mutableConnection()
    const controller = new OperationsController(remoteFixture(), connection.handle, connection.subscribeReset)
    const value = settingsFixture()
    const settingsStore = createSnapshotStore<SettingsScopeSnapshot<AutopilotSettings>>({
      status: 'ready',
      value,
      base: {},
      user: {},
      revision: 11,
      writable: true,
      mode: 'host',
    })
    const mutate = vi
      .fn<SettingsScope<AutopilotSettings>['mutate']>()
      .mockRejectedValueOnce(new Error('Tracker provider cannot change while FIX-42 depends on it.'))
    const scope: SettingsScope<AutopilotSettings> = {
      ...settingsStore,
      mutate,
      set: vi.fn(),
      unset: vi.fn(),
    }
    render(
      <AutopilotSettingsPanel
        close={vi.fn()}
        actions={settingsActions(controller, scope)}
        useSettings={selectorHook(settingsStore)}
        useOperations={selectorHook(controller.store)}
        t={t}
      />,
    )

    const queue = await screen.findByRole('spinbutton', { name: 'Maximum queued runs' })
    fireEvent.change(queue, { target: { value: '25' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum concurrent runs' }), {
      target: { value: '3' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledOnce()
    })
    expect(mutate.mock.calls[0]?.[1]).toBe(11)
    expect(mutate.mock.calls[0]?.[0]).toContainEqual({ op: 'set', path: ['maxRunning'], value: 3 })
    expect(await screen.findByText(/Settings changed on the Host/)).toBeTruthy()
    expect(screen.getByText(/Tracker provider cannot change while FIX-42/)).toBeTruthy()
  })

  it('edits root-owned provider, notification, URL, and retention settings without provider secrets', async () => {
    const connection = mutableConnection()
    const controller = new OperationsController(remoteFixture(), connection.handle, connection.subscribeReset)
    const settingsStore = createSnapshotStore<SettingsScopeSnapshot<AutopilotSettings>>({
      status: 'ready',
      value: settingsFixture(),
      base: {},
      user: {},
      revision: 12,
      writable: true,
      mode: 'host',
    })
    const mutate = vi.fn<SettingsScope<AutopilotSettings>['mutate']>().mockResolvedValue(undefined)
    render(
      <AutopilotSettingsPanel
        close={vi.fn()}
        actions={settingsActions(controller, { ...settingsStore, mutate, set: vi.fn(), unset: vi.fn() })}
        useSettings={selectorHook(settingsStore)}
        useOperations={selectorHook(controller.store)}
        t={t}
      />,
    )

    fireEvent.change(await screen.findByLabelText('Code host provider reference'), {
      target: { value: 'fixture-code-host' },
    })
    fireEvent.click(screen.getByLabelText('Allow provider-owned workflow file changes'))
    fireEvent.click(screen.getByRole('button', { name: 'Add notification destination' }))
    fireEvent.change(screen.getByLabelText('Notification provider reference'), { target: { value: 'ntfy' } })
    fireEvent.change(screen.getByLabelText('Destination reference'), { target: { value: 'operators' } })
    fireEvent.click(screen.getByLabelText('Completed'))
    fireEvent.change(screen.getByLabelText('Ticket summary disclosure'), { target: { value: 'full' } })
    fireEvent.change(screen.getByLabelText('Run URL template'), { target: { value: 'https://host/runs/{runId}' } })
    fireEvent.change(screen.getByLabelText('Ticket URL template'), {
      target: { value: 'https://tracker/tickets/{displayKey}' },
    })
    fireEvent.change(screen.getByLabelText('Cleanup retention (days)'), { target: { value: '14' } })
    fireEvent.click(screen.getByLabelText('Automatically remove eligible merged worktrees after retention'))
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))

    await waitFor(() => expect(mutate).toHaveBeenCalledOnce())
    expect(mutate.mock.calls[0]?.[1]).toBe(12)
    const values = Object.fromEntries(
      (mutate.mock.calls[0]?.[0] ?? []).map((operation) => [operation.path[0], operation.value]),
    )
    expect(values).toMatchObject({
      codeHostProvider: 'fixture-code-host',
      allowWorkflowChanges: true,
      notificationSubscriptions: [
        {
          providerId: 'ntfy',
          destinationId: 'operators',
          events: ['failed', 'completed'],
          summaryDisclosure: 'full',
        },
      ],
      runUrlTemplate: 'https://host/runs/{runId}',
      issueUrlTemplate: 'https://tracker/tickets/{displayKey}',
      autoCleanupEnabled: false,
      cleanupRetentionDays: 14,
    })
    expect(screen.queryByLabelText('New secret value (write only)')).toBeNull()
    controller.dispose()
  })

  it('keeps credential writes disabled when DSH cannot describe credential capability', async () => {
    const connection = mutableConnection()
    const snapshot = operationsFixture()
    const provider = snapshot.providers[0]
    if (provider?.setup.status !== 'available') throw new Error('expected provider setup fixture')
    provider.setup.credentialRefs = [{ label: 'Inbound webhook secret', ref: 'autopilot-webhook' }]
    const controller = new OperationsController(remoteFixture(snapshot), connection.handle, connection.subscribeReset)
    const value = settingsFixture()
    const settingsStore = createSnapshotStore<SettingsScopeSnapshot<AutopilotSettings>>({
      status: 'ready',
      value,
      base: {},
      user: {},
      revision: 1,
      writable: true,
      mode: 'host',
    })
    render(
      <AutopilotSettingsPanel
        close={vi.fn()}
        actions={{
          ...settingsActions(controller, { ...settingsStore, mutate: vi.fn(), set: vi.fn(), unset: vi.fn() }),
          describeCredentials: async () => {
            throw new Error('credential Remote unavailable')
          },
        }}
        useSettings={selectorHook(settingsStore)}
        useOperations={selectorHook(controller.store)}
        t={t}
      />,
    )

    const input = await screen.findByLabelText('New secret value (write only)')
    expect((input as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Store in DSH Credentials' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('aborts a provider test when Settings is closed', async () => {
    const connection = mutableConnection()
    const controller = new OperationsController(remoteFixture(), connection.handle, connection.subscribeReset)
    const settingsStore = createSnapshotStore<SettingsScopeSnapshot<AutopilotSettings>>({
      status: 'ready',
      value: settingsFixture(),
      base: {},
      user: {},
      revision: 1,
      writable: true,
      mode: 'host',
    })
    let testSignal: AbortSignal | undefined
    const view = render(
      <AutopilotSettingsPanel
        close={vi.fn()}
        actions={{
          ...settingsActions(controller, { ...settingsStore, mutate: vi.fn(), set: vi.fn(), unset: vi.fn() }),
          testProvider: (_providerId, signal) => {
            testSignal = signal
            return new Promise<never>(() => {})
          },
        }}
        useSettings={selectorHook(settingsStore)}
        useOperations={selectorHook(controller.store)}
        t={t}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }))
    expect(testSignal?.aborted).toBe(false)
    view.unmount()
    expect(testSignal?.aborted).toBe(true)
    controller.dispose()
  })
})

function selectorHook<T>(source: { getSnapshot(): T; subscribe(listener: () => void): () => void }) {
  return <S,>(selector: (value: T) => S): S => {
    const value = useSyncExternalStore(source.subscribe, source.getSnapshot)
    return selector(value)
  }
}

function operationsActions(controller: OperationsController) {
  return {
    connect: () => controller.connect(),
    refresh: () => controller.refresh(),
    setQuery: (patch: Parameters<OperationsController['setQuery']>[0]) => controller.setQuery(patch),
    loadRun: (runId: string) => controller.loadRun(runId),
    inspectWorktree: (runId: string, signal?: AbortSignal) => controller.inspectWorktree(runId, signal),
    previewCleanup: (runId: string, signal?: AbortSignal) => controller.previewCleanup(runId, signal),
    runCommand: (
      kind: Parameters<OperationsController['runCommand']>[0],
      target?: Parameters<OperationsController['runCommand']>[1],
    ) => controller.runCommand(kind, target),
  }
}

function settingsActions(controller: OperationsController, scope: SettingsScope<AutopilotSettings>) {
  return {
    connect: () => controller.connect(),
    save: (ops: Parameters<typeof scope.mutate>[0], revision?: number) => scope.mutate(ops, revision),
    testProvider: (providerId: string, signal?: AbortSignal) => controller.testProvider(providerId, signal),
    describeCredentials: async () => ({}),
    setCredential: async () => {},
    unsetCredential: async () => {},
    openSettingsDocument: async () => {},
  }
}

function settingsFixture(): AutopilotSettings {
  return {
    trackerProvider: 'external',
    codeHostProvider: 'github',
    allowWorkflowChanges: false,
    notificationSubscriptions: [],
    runUrlTemplate: '',
    issueUrlTemplate: '',
    maxQueued: 20,
    maxRunning: 2,
    maxBriefBytes: 32_768,
    reconcileIntervalSeconds: 300,
    executionMode: 'disabled',
    targetRepository: '',
    targetBaseBranch: '',
    managedWorktreeRoot: '',
    runtimeStorePath: '',
    autoCleanupEnabled: true,
    cleanupRetentionDays: 7,
    deploymentTokenCap: 100_000,
    perRunTokenCap: 50_000,
    runTokenAllowance: 40_000,
  }
}
