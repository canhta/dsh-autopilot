import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Admission } from '../src/admission.js'
import { AutopilotConfig } from '../src/config.js'
import { Ingress, TRACKER_INGRESS_PATH } from '../src/ingress.js'
import { Reconciliation } from '../src/reconciliation.js'
import { createFixtureTrackerProvider } from '../src/testing.js'
import {
  readinessGeneration,
  Tracker,
  TrackerProviderError,
  trackerBindingId,
  trackerCommentId,
  trackerIssueId,
  trackerProviderId,
} from '../src/tracker.js'
import { Deferred, disposeContext, mountHostServices } from './dsh-fixtures.js'

const contexts = new Set<Context>()
const temporaryDirectories = new Set<string>()

interface ReconciliationHarness {
  readonly ctx: Context
  readonly storagePath: string
}

async function createHarness(
  prefix: string,
  settings: Record<string, unknown>,
  withWebServer = false,
): Promise<ReconciliationHarness> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.add(directory)
  const storagePath = join(directory, 'state.sqlite')
  const ctx = await mountHostServices(storagePath, settings)
  contexts.add(ctx)
  if (withWebServer) await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(Tracker)
  return { ctx, storagePath }
}

async function mountReconciliation(ctx: Context): Promise<Fiber> {
  await ctx.plugin(AutopilotConfig)
  await ctx.plugin(Admission)
  return ctx.plugin(Reconciliation)
}

async function mountIngress(ctx: Context): Promise<Fiber> {
  const reconciliation = await mountReconciliation(ctx)
  await ctx.plugin(Ingress)
  return reconciliation
}

async function disposeTrackedContext(ctx: Context): Promise<void> {
  contexts.delete(ctx)
  await disposeContext(ctx)
}

const candidate = {
  bindingId: trackerBindingId('fixture:project'),
  issueId: trackerIssueId('issue-1'),
  displayKey: 'FIX-1',
  summary: 'Reconcile safely',
  priorityRank: 1,
  isReady: true,
  labels: ['ready-for-agent'],
  comments: [
    {
      id: trackerCommentId('brief-1'),
      authorId: 'person-1',
      updatedAt: '2026-09-11T00:00:00.000Z',
      body: `# Agent Brief
dsh-autopilot:brief:v1
## Objective
Ship it.
## In Scope
Reconciliation.
## Acceptance Criteria
It works.
## Constraints
Keep state durable.
## Context
Fixture.`,
    },
  ],
  dependencies: [],
  readiness: {
    kind: 'transition' as const,
    generation: readinessGeneration('transition-1'),
    actorId: 'person-1',
    actorKind: 'human' as const,
    occurredAt: '2026-09-11T00:01:00.000Z',
  },
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.allSettled([...contexts].map(disposeContext))
  contexts.clear()
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })))
  temporaryDirectories.clear()
})

describe('reconciliation service seam', () => {
  it('owns one startup and periodic reconciliation until disposal', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-11T00:00:00.000Z'))
    const { ctx } = await createHarness('dsh-autopilot-reconciliation-', {
      'dsh-autopilot': { trackerProvider: 'fixture', reconcileIntervalSeconds: 5 },
    })
    let reads = 0
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues: [],
        readCandidates: () => {
          reads += 1
          return Promise.resolve({ issues: [] })
        },
      }),
    )
    const fiber = await mountReconciliation(ctx)

    await vi.advanceTimersByTimeAsync(0)
    expect(reads).toBe(1)
    expect(ctx.autopilotReconciliation.snapshot()).toMatchObject({
      active: 0,
      lastAttempt: { source: 'startup', outcome: 'succeeded' },
      nextScheduledAt: '2026-09-11T00:00:05.000Z',
    })

    await vi.advanceTimersByTimeAsync(5_000)
    expect(reads).toBe(2)
    expect(ctx.autopilotReconciliation.snapshot()).toMatchObject({
      active: 0,
      lastAttempt: { source: 'scheduled', outcome: 'succeeded' },
      nextScheduledAt: '2026-09-11T00:00:10.000Z',
    })

    await fiber.dispose()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(reads).toBe(2)
  })

  it('reports queue saturation through bounded aggregate counts', async () => {
    const { ctx } = await createHarness('dsh-autopilot-reconciliation-saturation-', {
      'dsh-autopilot': { trackerProvider: 'fixture', maxQueued: 1 },
    })
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues: [
          candidate,
          {
            ...candidate,
            issueId: trackerIssueId('issue-2'),
            displayKey: 'FIX-2',
            priorityRank: 2,
            readiness: { ...candidate.readiness, generation: readinessGeneration('transition-2') },
          },
        ],
      }),
    )
    await mountReconciliation(ctx)

    await vi.waitFor(() => {
      expect(ctx.autopilotReconciliation.snapshot()).toMatchObject({
        lastAttempt: { source: 'startup', outcome: 'succeeded', admitted: 1, deferred: 1, rejected: 0 },
      })
    })
  })

  it('fences a late startup result before the lifecycle owner retires', async () => {
    const { ctx } = await createHarness('dsh-autopilot-reconciliation-dispose-', {
      'dsh-autopilot': { trackerProvider: 'fixture' },
    })
    const started = new Deferred<void>()
    const release = new Deferred<void>()
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues: [candidate],
        readCandidates: async () => {
          started.resolve()
          await release.promise
          return { issues: [candidate] }
        },
      }),
    )
    const fiber = await mountReconciliation(ctx)
    await started.promise

    const disposing = fiber.dispose()
    release.resolve()
    await disposing

    expect(ctx.admission.snapshot().runs).toEqual([])
  })

  it('cancels provider I/O owned by a disposing reconciliation generation', async () => {
    const { ctx } = await createHarness('dsh-autopilot-reconciliation-cancel-', {
      'dsh-autopilot': { trackerProvider: 'fixture' },
    })
    const started = new Deferred<void>()
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues: [candidate],
        readCandidates: ({ signal }) =>
          new Promise((_resolve, reject) => {
            started.resolve()
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          }),
      }),
    )
    const fiber = await mountReconciliation(ctx)
    await started.promise

    await expect(fiber.dispose()).resolves.toBeUndefined()

    expect(ctx.admission.snapshot().runs).toEqual([])
  })

  it('reconciles through a freshly remounted selected provider', async () => {
    vi.useFakeTimers()
    const { ctx } = await createHarness('dsh-autopilot-reconciliation-remount-', {
      'dsh-autopilot': { trackerProvider: 'fixture' },
    })
    let firstReads = 0
    const disposeFirst = ctx.tracker.register(
      createFixtureTrackerProvider({
        issues: [],
        readCandidates: () => {
          firstReads += 1
          return Promise.resolve({ issues: [] })
        },
      }),
    )
    await mountReconciliation(ctx)
    await vi.advanceTimersByTimeAsync(0)
    expect(firstReads).toBe(1)

    await disposeFirst()
    let replacementReads = 0
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues: [],
        readCandidates: () => {
          replacementReads += 1
          return Promise.resolve({ issues: [] })
        },
      }),
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(replacementReads).toBe(1)
    expect(ctx.autopilotReconciliation.snapshot()).toMatchObject({
      lastAttempt: { source: 'startup', outcome: 'succeeded' },
    })
  })

  it('coalesces selected-provider availability into one retry while startup is active', async () => {
    const { ctx } = await createHarness('dsh-autopilot-reconciliation-provider-race-', {
      'dsh-autopilot': { trackerProvider: 'fixture' },
    })
    const started = new Deferred<void>()
    const release = new Deferred<void>()
    let firstReads = 0
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues: [],
        readCandidates: async () => {
          firstReads += 1
          started.resolve()
          await release.promise
          return { issues: [] }
        },
      }),
    )
    await mountReconciliation(ctx)
    await started.promise

    let replacementReads = 0
    await ctx.settings.update('dsh-autopilot', { trackerProvider: 'replacement' })
    ctx.tracker.register(
      createFixtureTrackerProvider({
        id: trackerProviderId('replacement'),
        issues: [],
        readCandidates: () => {
          replacementReads += 1
          return Promise.resolve({ issues: [] })
        },
      }),
    )
    expect(replacementReads).toBe(0)
    release.resolve()

    await vi.waitFor(() => {
      expect(replacementReads).toBe(1)
    })
    expect(firstReads).toBe(1)
    expect(ctx.autopilotReconciliation.snapshot().lastAttempt).toMatchObject({
      source: 'startup',
      outcome: 'succeeded',
    })
  })

  it('acknowledges authenticated HTTP ingress only after durable admission', async () => {
    const { ctx } = await createHarness(
      'dsh-autopilot-ingress-',
      { 'dsh-autopilot': { trackerProvider: 'fixture' } },
      true,
    )
    let issues: (typeof candidate)[] = []
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues,
        readCandidates: () => Promise.resolve({ issues }),
        verifyIngress: ({ headers, body }) => {
          if (!headers.some((header) => header.name === 'authorization' && header.value === 'fixture-secret')) {
            throw new TrackerProviderError('authentication', 'fixture authentication failed')
          }
          if (new TextDecoder().decode(body) !== '{"event":"changed"}') {
            throw new TrackerProviderError('invalid-response', 'fixture payload was malformed')
          }
          return Promise.resolve({ deliveryId: 'fixture:delivery-1' })
        },
      }),
    )
    await mountIngress(ctx)
    await vi.waitFor(() => {
      expect(ctx.autopilotReconciliation.snapshot().lastAttempt).toMatchObject({
        source: 'startup',
        outcome: 'succeeded',
      })
    })
    issues = [candidate]

    const response = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}${TRACKER_INGRESS_PATH}`, {
      method: 'POST',
      headers: { authorization: 'fixture-secret', 'content-type': 'application/json' },
      body: '{"event":"changed"}',
    })

    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(ctx.admission.snapshot()).toMatchObject({
      acceptedIngress: ['fixture:delivery-1'],
      runs: [{ displayKey: 'FIX-1', state: 'queued' }],
    })
    expect(ctx.autopilotReconciliation.snapshot()).toMatchObject({
      active: 0,
      lastAttempt: { source: 'webhook', outcome: 'succeeded', admitted: 1 },
    })
  })

  it('handles empty and multibyte payload boundaries by UTF-8 byte length', async () => {
    const { ctx } = await createHarness(
      'dsh-autopilot-ingress-boundaries-',
      { 'dsh-autopilot': { trackerProvider: 'fixture' } },
      true,
    )
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues: [],
        verifyIngress: ({ body }) => Promise.resolve({ deliveryId: `fixture:delivery-${String(body.byteLength)}` }),
      }),
    )
    await mountIngress(ctx)
    await vi.waitFor(() => {
      expect(ctx.autopilotReconciliation.snapshot().lastAttempt).toMatchObject({
        source: 'startup',
        outcome: 'succeeded',
      })
    })
    const url = `http://127.0.0.1:${String(ctx.webServer.port)}${TRACKER_INGRESS_PATH}`

    const empty = await fetch(url, { method: 'POST' })
    const exactMultibyte = await fetch(url, { method: 'POST', body: '😀'.repeat((256 * 1024) / 4) })
    const oversizedMultibyte = await fetch(url, { method: 'POST', body: `😀${'x'.repeat(256 * 1024 - 3)}` })

    expect([empty.status, exactMultibyte.status, oversizedMultibyte.status]).toEqual([204, 204, 413])
    expect(ctx.admission.snapshot().acceptedIngress).toEqual(['fixture:delivery-0', 'fixture:delivery-262144'])
  })

  it('retries saturated HTTP ingress without consuming its delivery receipt', async () => {
    const { ctx } = await createHarness(
      'dsh-autopilot-ingress-saturation-',
      { 'dsh-autopilot': { trackerProvider: 'fixture', maxQueued: 1 } },
      true,
    )
    const secondCandidate = {
      ...candidate,
      issueId: trackerIssueId('issue-2'),
      displayKey: 'FIX-2',
      priorityRank: 2,
      readiness: { ...candidate.readiness, generation: readinessGeneration('transition-2') },
    }
    let issues: (typeof candidate)[] = [candidate]
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues,
        readCandidates: () => Promise.resolve({ issues }),
        verifyIngress: () => Promise.resolve({ deliveryId: 'fixture:capacity-delivery' }),
      }),
    )
    await mountIngress(ctx)
    await vi.waitFor(() => {
      expect(ctx.admission.snapshot().runs).toHaveLength(1)
    })
    issues = [candidate, secondCandidate]

    const response = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}${TRACKER_INGRESS_PATH}`, {
      method: 'POST',
      body: '{}',
    })

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('1')
    expect(await response.text()).toBe('webhook rejected')
    expect(ctx.admission.snapshot()).toMatchObject({
      acceptedIngress: [],
      runs: [{ displayKey: 'FIX-1', state: 'queued' }],
    })
    expect(ctx.autopilotReconciliation.snapshot().lastAttempt).toMatchObject({
      source: 'webhook',
      outcome: 'failed',
      failure: { code: 'overloaded' },
    })
  })

  it('rejects unauthenticated, malformed, and oversized ingress without mutating admission', async () => {
    const { ctx } = await createHarness(
      'dsh-autopilot-ingress-reject-',
      { 'dsh-autopilot': { trackerProvider: 'fixture' } },
      true,
    )
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues: [candidate],
        verifyIngress: ({ headers, body }) => {
          if (!headers.some((header) => header.name === 'authorization' && header.value === 'fixture-secret')) {
            throw new TrackerProviderError('authentication', 'must not expose fixture-secret')
          }
          if (new TextDecoder().decode(body) !== '{"event":"changed"}') {
            throw new TrackerProviderError('invalid-response', 'must not expose live-ticket-body')
          }
          return Promise.resolve({ deliveryId: 'fixture:delivery-1' })
        },
      }),
    )
    await mountIngress(ctx)
    await vi.waitFor(() => {
      expect(ctx.autopilotReconciliation.snapshot().lastAttempt).toMatchObject({
        source: 'startup',
        outcome: 'succeeded',
      })
    })
    const before = ctx.admission.snapshot()
    const url = `http://127.0.0.1:${String(ctx.webServer.port)}${TRACKER_INGRESS_PATH}`

    const unauthenticated = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"event":"changed"}',
    })
    expect(unauthenticated.status).toBe(401)
    expect(await unauthenticated.text()).toBe('unauthorized')
    expect(ctx.admission.snapshot()).toEqual(before)
    expect(ctx.autopilotReconciliation.snapshot().lastAttempt).toMatchObject({
      source: 'webhook',
      outcome: 'failed',
      failure: { code: 'authentication', message: 'Tracker authentication failed.' },
    })

    const malformed = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'fixture-secret', 'content-type': 'application/json' },
      body: 'live-ticket-body',
    })
    expect(malformed.status).toBe(400)
    expect(await malformed.text()).toBe('webhook rejected')
    expect(ctx.admission.snapshot()).toEqual(before)
    expect(JSON.stringify(ctx.autopilotReconciliation.snapshot())).not.toContain('fixture-secret')
    expect(JSON.stringify(ctx.autopilotReconciliation.snapshot())).not.toContain('live-ticket-body')

    const oversized = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'fixture-secret', 'content-type': 'application/json' },
      body: 'x'.repeat(256 * 1024 + 1),
    })
    expect(oversized.status).toBe(413)
    expect(ctx.admission.snapshot()).toEqual(before)
  })

  it('returns a bounded failure when the durable admission commit fails', async () => {
    const { ctx, storagePath } = await createHarness(
      'dsh-autopilot-ingress-durable-failure-',
      { 'dsh-autopilot': { trackerProvider: 'fixture' } },
      true,
    )
    let issues: (typeof candidate)[] = []
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues,
        readCandidates: () => Promise.resolve({ issues }),
        verifyIngress: () => Promise.resolve({ deliveryId: 'fixture:delivery-1' }),
      }),
    )
    await mountIngress(ctx)
    await vi.waitFor(() => {
      expect(ctx.autopilotReconciliation.snapshot().lastAttempt).toMatchObject({
        source: 'startup',
        outcome: 'succeeded',
      })
    })
    issues = [candidate]
    const database = new DatabaseSync(storagePath)
    database.exec(`CREATE TRIGGER reject_admission_update
      BEFORE UPDATE ON u_autopilot_admission_state
      BEGIN
        SELECT RAISE(ABORT, 'must not expose durable storage detail');
      END`)
    database.close()

    const response = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}${TRACKER_INGRESS_PATH}`, {
      method: 'POST',
      body: '{}',
    })

    expect(response.status).toBe(503)
    expect(await response.text()).toBe('webhook rejected')
    expect(ctx.admission.snapshot()).toMatchObject({ acceptedIngress: [], runs: [] })
    expect(ctx.autopilotReconciliation.snapshot().lastAttempt).toMatchObject({
      source: 'webhook',
      outcome: 'failed',
      failure: { code: 'internal', message: 'Reconciliation failed before it could commit.' },
    })
    expect(JSON.stringify(ctx.autopilotReconciliation.snapshot())).not.toContain('durable storage detail')
  })

  it('deduplicates concurrent ingress and reconciliation into one logical run', async () => {
    const { ctx } = await createHarness(
      'dsh-autopilot-ingress-concurrent-',
      { 'dsh-autopilot': { trackerProvider: 'fixture' } },
      true,
    )
    let issues: (typeof candidate)[] = []
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues,
        readCandidates: () => Promise.resolve({ issues }),
        verifyIngress: () => Promise.resolve({ deliveryId: 'fixture:delivery-1' }),
      }),
    )
    await mountIngress(ctx)
    await vi.waitFor(() => {
      expect(ctx.autopilotReconciliation.snapshot().lastAttempt).toMatchObject({
        source: 'startup',
        outcome: 'succeeded',
      })
    })
    issues = [candidate]
    const url = `http://127.0.0.1:${String(ctx.webServer.port)}${TRACKER_INGRESS_PATH}`

    const [first, second] = await Promise.all([
      fetch(url, { method: 'POST', body: '{}' }),
      Promise.all([fetch(url, { method: 'POST', body: '{}' }), ctx.admission.reconcile({ source: 'scheduled' })]).then(
        ([response]) => response,
      ),
    ])

    expect([first.status, second.status]).toEqual([204, 204])
    expect(ctx.admission.snapshot()).toMatchObject({
      acceptedIngress: ['fixture:delivery-1'],
      runs: [{ displayKey: 'FIX-1', state: 'queued' }],
    })
  })

  it('bounds concurrent ingress work and exposes overload without retaining another request', async () => {
    const { ctx } = await createHarness('dsh-autopilot-ingress-overload-', {
      'dsh-autopilot': { trackerProvider: 'fixture' },
    })
    const releases = Array.from({ length: 32 }, () => new Deferred<void>())
    let verifications = 0
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues: [],
        verifyIngress: async () => {
          const index = verifications
          verifications += 1
          const release = releases[index]
          if (release === undefined) throw new Error('unexpected retained ingress attempt')
          await release.promise
          return { deliveryId: 'fixture:delivery-1' }
        },
      }),
    )
    await mountReconciliation(ctx)
    await vi.waitFor(() => {
      expect(ctx.autopilotReconciliation.snapshot().lastAttempt).toMatchObject({ outcome: 'succeeded' })
    })
    const request = { method: 'POST', headers: [], body: new Uint8Array() }
    const retained = releases.map(() => ctx.autopilotReconciliation.acceptIngress(request))
    await vi.waitFor(() => {
      expect(verifications).toBe(32)
    })

    await expect(ctx.autopilotReconciliation.acceptIngress(request)).rejects.toMatchObject({ code: 'overloaded' })
    expect(verifications).toBe(32)
    expect(ctx.autopilotReconciliation.snapshot()).toMatchObject({
      active: 32,
      lastAttempt: { source: 'webhook', outcome: 'failed', failure: { code: 'overloaded' } },
    })

    for (const release of releases) release.resolve()
    await Promise.all(retained)
  })

  it('bounds HTTP handlers before reading another request body', async () => {
    const { ctx } = await createHarness(
      'dsh-autopilot-http-handler-overload-',
      { 'dsh-autopilot': { trackerProvider: 'fixture' } },
      true,
    )
    const releases = Array.from({ length: 32 }, () => new Deferred<void>())
    let verifications = 0
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues: [],
        verifyIngress: async () => {
          const index = verifications
          verifications += 1
          const release = releases[index]
          if (release === undefined) throw new Error('unexpected retained HTTP handler')
          await release.promise
          return { deliveryId: `fixture:delivery-${String(index)}` }
        },
      }),
    )
    await mountIngress(ctx)
    await vi.waitFor(() => {
      expect(ctx.autopilotReconciliation.snapshot().lastAttempt).toMatchObject({ outcome: 'succeeded' })
    })
    const url = `http://127.0.0.1:${String(ctx.webServer.port)}${TRACKER_INGRESS_PATH}`
    const retained = releases.map(() => fetch(url, { method: 'POST', body: '{}' }))
    await vi.waitFor(() => {
      expect(verifications).toBe(32)
    })

    const rejected = await fetch(url, { method: 'POST', body: '{}' })
    expect(rejected.status).toBe(429)
    expect(rejected.headers.get('retry-after')).toBe('1')
    expect(verifications).toBe(32)

    for (const release of releases) release.resolve()
    const responses = await Promise.all(retained)
    expect(responses.every((response) => response.status === 204)).toBe(true)
  })

  it('does not start overlapping periodic workers', async () => {
    vi.useFakeTimers()
    const { ctx } = await createHarness('dsh-autopilot-reconciliation-overlap-', {
      'dsh-autopilot': { trackerProvider: 'fixture', reconcileIntervalSeconds: 5 },
    })
    const release = new Deferred<void>()
    let reads = 0
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues: [],
        readCandidates: async () => {
          reads += 1
          await release.promise
          return { issues: [] }
        },
      }),
    )
    const fiber = await mountReconciliation(ctx)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(reads).toBe(1)
    expect(ctx.autopilotReconciliation.snapshot().active).toBe(1)

    release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(ctx.autopilotReconciliation.snapshot().active).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(reads).toBe(2)

    await fiber.dispose()
  })

  it('drains an in-flight ingress and fences its late result during disposal', async () => {
    const { ctx } = await createHarness(
      'dsh-autopilot-ingress-dispose-',
      { 'dsh-autopilot': { trackerProvider: 'fixture' } },
      true,
    )
    const started = new Deferred<void>()
    const release = new Deferred<void>()
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues: [candidate],
        verifyIngress: async () => {
          started.resolve()
          await release.promise
          return { deliveryId: 'fixture:delivery-1' }
        },
      }),
    )
    const reconciliation = await mountIngress(ctx)
    await vi.waitFor(() => {
      expect(ctx.autopilotReconciliation.snapshot().lastAttempt).toMatchObject({
        source: 'startup',
        outcome: 'succeeded',
      })
    })

    const response = fetch(`http://127.0.0.1:${String(ctx.webServer.port)}${TRACKER_INGRESS_PATH}`, {
      method: 'POST',
      body: '{}',
    })
    await started.promise
    let disposed = false
    const disposing = reconciliation.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release.resolve()
    await disposing

    expect((await response).status).toBe(503)
    expect(ctx.admission.snapshot()).toMatchObject({ acceptedIngress: [], runs: [{ displayKey: 'FIX-1' }] })
  })

  it('resumes startup reconciliation after restart without changing run identity or order', async () => {
    const { ctx: first, storagePath } = await createHarness('dsh-autopilot-reconciliation-restart-', {
      'dsh-autopilot': { trackerProvider: 'fixture' },
    })
    const secondCandidate = {
      ...candidate,
      issueId: trackerIssueId('issue-2'),
      displayKey: 'FIX-2',
      priorityRank: 2,
      readiness: { ...candidate.readiness, generation: readinessGeneration('transition-2') },
    }
    first.tracker.register(createFixtureTrackerProvider({ issues: [secondCandidate, candidate] }))
    await mountReconciliation(first)
    await vi.waitFor(() => {
      expect(first.autopilotReconciliation.snapshot().lastAttempt).toMatchObject({
        source: 'startup',
        outcome: 'succeeded',
      })
    })
    const before = first.admission.snapshot().runs
    await disposeTrackedContext(first)

    const second = await mountHostServices(storagePath, { 'dsh-autopilot': { trackerProvider: 'fixture' } })
    contexts.add(second)
    await second.plugin(Tracker)
    second.tracker.register(createFixtureTrackerProvider({ issues: [candidate, secondCandidate] }))
    await second.plugin(AutopilotConfig)
    await second.plugin(Admission)
    await second.plugin(Reconciliation)
    await vi.waitFor(() => {
      expect(second.autopilotReconciliation.snapshot().lastAttempt).toMatchObject({
        source: 'startup',
        outcome: 'succeeded',
      })
    })

    expect(second.admission.snapshot().runs).toEqual(before)
  })

  it('exposes bounded provider diagnostics without leaking upstream details', async () => {
    const { ctx } = await createHarness('dsh-autopilot-reconciliation-diagnostic-', {
      'dsh-autopilot': { trackerProvider: 'fixture' },
    })
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues: [],
        readCandidates: () =>
          Promise.reject(new TrackerProviderError('rate-limit', 'secret upstream ticket response', 3_000)),
      }),
    )
    await mountReconciliation(ctx)
    await vi.waitFor(() => {
      expect(ctx.autopilotReconciliation.snapshot().lastAttempt).toMatchObject({
        source: 'startup',
        outcome: 'failed',
        failure: {
          code: 'rate-limit',
          message: 'Tracker rate limiting deferred reconciliation.',
          retryAfterMs: 3_000,
        },
      })
    })
    expect(JSON.stringify(ctx.autopilotReconciliation.snapshot())).not.toContain('secret upstream ticket response')
  })
})
