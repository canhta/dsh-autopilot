import type { ConnectionHandle, ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { AutopilotRemoteNamespace } from '../src/remote.js'
import type { OperationsSnapshot, RunDetailView, RunSummaryView } from '../src/web.js'

const now = '2026-09-12T00:00:00.000Z'

export function runFixture(overrides: Partial<RunSummaryView> = {}): RunSummaryView {
  return {
    runId: 'run_fixture',
    displayKey: 'EXT-42',
    summary: 'A very long multilingual fixture title that must remain readable — 修复发布流程中的边界条件',
    providerId: 'external',
    providerName: 'External tracker',
    lifecycle: 'blocked',
    reason: 'Waiting for a human in the tracker: choose the supported migration boundary.',
    priorityRank: 3,
    phase: 'Outcome',
    queuedAt: now,
    updatedAt: now,
    attention: true,
    usage: { kind: 'unknown', reason: 'Provider did not report usage.' },
    ticket: { status: 'unknown', reason: 'Tracker URL unavailable.' },
    session: { status: 'unknown', reason: 'Session shortcut unavailable.' },
    pullRequest: { status: 'unknown', reason: 'PR integration pending.' },
    deliveries: [],
    actions: [],
    ...overrides,
  }
}

export function runDetailFixture(overrides: Partial<RunDetailView> = {}): RunDetailView {
  return {
    ...runFixture(),
    brief: { updatedAt: now, content: '# Agent Brief\n\nKeep human authorization in the tracker.' },
    outcome: { kind: 'blocked', summary: 'Choose the migration boundary.', evidence: ['No Web bypass was offered.'] },
    timeline: [{ at: now, label: 'Admitted to queue' }],
    ...overrides,
  }
}

export function operationsFixture(overrides: Partial<OperationsSnapshot> = {}): OperationsSnapshot {
  const run = runFixture()
  return {
    revision: 7,
    fetchedAt: now,
    scheduler: { mode: 'enabled', changedAt: now },
    providers: [
      {
        id: 'external',
        displayName: 'External tracker',
        configurationNamespace: 'external-tracker',
        selected: true,
        availability: 'available',
        setup: {
          status: 'available',
          mcpServerName: 'fixture-mcp',
          resources: [],
          credentialRefs: [],
          lookup: { status: 'unavailable', reason: 'Fixture has no lookup.' },
        },
      },
    ],
    codeHostProviders: [],
    runs: { items: [run], total: 1, offset: 0, limit: 50 },
    budget: { deploymentCap: 100_000, settled: 12_000, reserved: 8_000, remaining: 80_000, usageUncertain: false },
    schedule: { timezone: 'Asia/Ho_Chi_Minh', reconcileIntervalSeconds: 300 },
    reconciliation: { active: 0, nextScheduledAt: now },
    commands: [],
    integrations: {
      deliveries: { status: 'unavailable', reason: 'No fixture delivery contribution.' },
      worktrees: { status: 'unavailable', reason: 'No fixture worktree contribution.' },
    },
    ...overrides,
  }
}

export function remoteFixture(snapshot = operationsFixture(), detail = runDetailFixture()): AutopilotRemoteNamespace {
  return {
    operations: async () => ({ ok: true, value: snapshot }),
    run: async () => ({ ok: true, value: detail }),
    worktree: async () => ({ ok: true, value: null }),
    previewCleanup: async () => ({ ok: true, value: null }),
    command: async (request) => ({
      ok: true,
      value: { requestId: request.requestId, kind: request.kind, status: 'accepted', acceptedAt: now },
    }),
    commandStatus: async (requestId) => ({
      ok: true,
      value: { requestId, kind: 'reconcile', status: 'succeeded', acceptedAt: now, finishedAt: now },
    }),
    testProvider: async (providerId) => ({ ok: true, value: { providerId, checkedAt: now, status: 'ready' } }),
  }
}

export interface MutableConnection {
  readonly handle: ConnectionHandle
  set(state: ConnectionState): void
  reset(): void
  subscribeReset(listener: () => void): () => void
}

export function mutableConnection(initial: ConnectionState = 'connected'): MutableConnection {
  let state = initial
  const listeners = new Set<() => void>()
  const resets = new Set<() => void>()
  return {
    handle: {
      isLoopback: true,
      state: {
        getSnapshot: () => state,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      },
    } as ConnectionHandle,
    set(next) {
      state = next
      for (const listener of [...listeners]) listener()
    },
    reset() {
      for (const listener of [...resets]) listener()
    },
    subscribeReset(listener) {
      resets.add(listener)
      return () => {
        resets.delete(listener)
      }
    },
  }
}
