import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
} from '../src/tracker.js'
import { Deferred, disposeContext, mountHostServices } from './dsh-fixtures.js'

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

afterEach(() => {
  vi.useRealTimers()
})

describe('reconciliation service seam', () => {
  it('owns one startup and periodic reconciliation until disposal', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-11T00:00:00.000Z'))
    const directory = await mkdtemp(join(tmpdir(), 'dsh-autopilot-reconciliation-'))
    const ctx = await mountHostServices(join(directory, 'state.sqlite'), {
      'dsh-autopilot': { trackerProvider: 'fixture', reconcileIntervalSeconds: 5 },
    })
    await ctx.plugin(Tracker)
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
    await ctx.plugin(AutopilotConfig)
    await ctx.plugin(Admission)
    const fiber = await ctx.plugin(Reconciliation)

    await vi.advanceTimersByTimeAsync(0)
    expect(reads).toBe(1)
    expect(ctx.reconciliation.snapshot()).toMatchObject({
      active: 0,
      lastAttempt: { source: 'startup', outcome: 'succeeded' },
      nextScheduledAt: '2026-09-11T00:00:05.000Z',
    })

    await vi.advanceTimersByTimeAsync(5_000)
    expect(reads).toBe(2)
    expect(ctx.reconciliation.snapshot()).toMatchObject({
      active: 0,
      lastAttempt: { source: 'scheduled', outcome: 'succeeded' },
      nextScheduledAt: '2026-09-11T00:00:10.000Z',
    })

    await fiber.dispose()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(reads).toBe(2)

    await disposeContext(ctx)
    await rm(directory, { recursive: true, force: true })
  })

  it('reports queue saturation through bounded aggregate counts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-autopilot-reconciliation-saturation-'))
    const ctx = await mountHostServices(join(directory, 'state.sqlite'), {
      'dsh-autopilot': { trackerProvider: 'fixture', maxQueued: 1 },
    })
    await ctx.plugin(Tracker)
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
    await ctx.plugin(AutopilotConfig)
    await ctx.plugin(Admission)
    await ctx.plugin(Reconciliation)

    await vi.waitFor(() => {
      expect(ctx.reconciliation.snapshot()).toMatchObject({
        lastAttempt: { source: 'startup', outcome: 'succeeded', admitted: 1, deferred: 1, rejected: 0 },
      })
    })

    await disposeContext(ctx)
    await rm(directory, { recursive: true, force: true })
  })

  it('fences a late startup result before the lifecycle owner retires', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-autopilot-reconciliation-dispose-'))
    const ctx = await mountHostServices(join(directory, 'state.sqlite'), {
      'dsh-autopilot': { trackerProvider: 'fixture' },
    })
    await ctx.plugin(Tracker)
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
    await ctx.plugin(AutopilotConfig)
    await ctx.plugin(Admission)
    const fiber = await ctx.plugin(Reconciliation)
    await started.promise

    const disposing = fiber.dispose()
    release.resolve()
    await disposing

    expect(ctx.admission.snapshot().runs).toEqual([])
    await disposeContext(ctx)
    await rm(directory, { recursive: true, force: true })
  })

  it('reconciles through a freshly remounted selected provider', async () => {
    vi.useFakeTimers()
    const directory = await mkdtemp(join(tmpdir(), 'dsh-autopilot-reconciliation-remount-'))
    const ctx = await mountHostServices(join(directory, 'state.sqlite'), {
      'dsh-autopilot': { trackerProvider: 'fixture' },
    })
    await ctx.plugin(Tracker)
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
    await ctx.plugin(AutopilotConfig)
    await ctx.plugin(Admission)
    await ctx.plugin(Reconciliation)
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
    expect(ctx.reconciliation.snapshot()).toMatchObject({
      lastAttempt: { source: 'startup', outcome: 'succeeded' },
    })
    await disposeContext(ctx)
    await rm(directory, { recursive: true, force: true })
  })

  it('acknowledges authenticated HTTP ingress only after durable admission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-autopilot-ingress-'))
    const ctx = await mountHostServices(join(directory, 'state.sqlite'), {
      'dsh-autopilot': { trackerProvider: 'fixture' },
    })
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(Tracker)
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
    await ctx.plugin(AutopilotConfig)
    await ctx.plugin(Admission)
    await ctx.plugin(Reconciliation)
    await ctx.plugin(Ingress)
    await vi.waitFor(() => {
      expect(ctx.reconciliation.snapshot().lastAttempt).toMatchObject({ source: 'startup', outcome: 'succeeded' })
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
    expect(ctx.reconciliation.snapshot()).toMatchObject({
      active: 0,
      lastAttempt: { source: 'webhook', outcome: 'succeeded', admitted: 1 },
    })

    await disposeContext(ctx)
    await rm(directory, { recursive: true, force: true })
  })

  it('rejects unauthenticated, malformed, and oversized ingress without mutating admission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-autopilot-ingress-reject-'))
    const ctx = await mountHostServices(join(directory, 'state.sqlite'), {
      'dsh-autopilot': { trackerProvider: 'fixture' },
    })
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(Tracker)
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
    await ctx.plugin(AutopilotConfig)
    await ctx.plugin(Admission)
    await ctx.plugin(Reconciliation)
    await ctx.plugin(Ingress)
    await vi.waitFor(() => {
      expect(ctx.reconciliation.snapshot().lastAttempt).toMatchObject({ source: 'startup', outcome: 'succeeded' })
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
    expect(ctx.reconciliation.snapshot().lastAttempt).toMatchObject({
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
    expect(JSON.stringify(ctx.reconciliation.snapshot())).not.toContain('fixture-secret')
    expect(JSON.stringify(ctx.reconciliation.snapshot())).not.toContain('live-ticket-body')

    const oversized = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'fixture-secret', 'content-type': 'application/json' },
      body: 'x'.repeat(256 * 1024 + 1),
    })
    expect(oversized.status).toBe(413)
    expect(ctx.admission.snapshot()).toEqual(before)

    await disposeContext(ctx)
    await rm(directory, { recursive: true, force: true })
  })

  it('returns a bounded failure when the durable admission commit fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-autopilot-ingress-durable-failure-'))
    const storagePath = join(directory, 'state.sqlite')
    const ctx = await mountHostServices(storagePath, {
      'dsh-autopilot': { trackerProvider: 'fixture' },
    })
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(Tracker)
    let issues: (typeof candidate)[] = []
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues,
        readCandidates: () => Promise.resolve({ issues }),
        verifyIngress: () => Promise.resolve({ deliveryId: 'fixture:delivery-1' }),
      }),
    )
    await ctx.plugin(AutopilotConfig)
    await ctx.plugin(Admission)
    await ctx.plugin(Reconciliation)
    await ctx.plugin(Ingress)
    await vi.waitFor(() => {
      expect(ctx.reconciliation.snapshot().lastAttempt).toMatchObject({ source: 'startup', outcome: 'succeeded' })
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
    expect(ctx.reconciliation.snapshot().lastAttempt).toMatchObject({
      source: 'webhook',
      outcome: 'failed',
      failure: { code: 'internal', message: 'Reconciliation failed before it could commit.' },
    })
    expect(JSON.stringify(ctx.reconciliation.snapshot())).not.toContain('durable storage detail')

    await disposeContext(ctx)
    await rm(directory, { recursive: true, force: true })
  })

  it('deduplicates concurrent ingress and reconciliation into one logical run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-autopilot-ingress-concurrent-'))
    const ctx = await mountHostServices(join(directory, 'state.sqlite'), {
      'dsh-autopilot': { trackerProvider: 'fixture' },
    })
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(Tracker)
    let issues: (typeof candidate)[] = []
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues,
        readCandidates: () => Promise.resolve({ issues }),
        verifyIngress: () => Promise.resolve({ deliveryId: 'fixture:delivery-1' }),
      }),
    )
    await ctx.plugin(AutopilotConfig)
    await ctx.plugin(Admission)
    await ctx.plugin(Reconciliation)
    await ctx.plugin(Ingress)
    await vi.waitFor(() => {
      expect(ctx.reconciliation.snapshot().lastAttempt).toMatchObject({ source: 'startup', outcome: 'succeeded' })
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

    await disposeContext(ctx)
    await rm(directory, { recursive: true, force: true })
  })

  it('does not start overlapping periodic workers', async () => {
    vi.useFakeTimers()
    const directory = await mkdtemp(join(tmpdir(), 'dsh-autopilot-reconciliation-overlap-'))
    const ctx = await mountHostServices(join(directory, 'state.sqlite'), {
      'dsh-autopilot': { trackerProvider: 'fixture', reconcileIntervalSeconds: 5 },
    })
    await ctx.plugin(Tracker)
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
    await ctx.plugin(AutopilotConfig)
    await ctx.plugin(Admission)
    const fiber = await ctx.plugin(Reconciliation)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(reads).toBe(1)
    expect(ctx.reconciliation.snapshot().active).toBe(1)

    release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(ctx.reconciliation.snapshot().active).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(reads).toBe(2)

    await fiber.dispose()
    await disposeContext(ctx)
    await rm(directory, { recursive: true, force: true })
  })

  it('drains an in-flight ingress and fences its late result during disposal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-autopilot-ingress-dispose-'))
    const ctx = await mountHostServices(join(directory, 'state.sqlite'), {
      'dsh-autopilot': { trackerProvider: 'fixture' },
    })
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(Tracker)
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
    await ctx.plugin(AutopilotConfig)
    await ctx.plugin(Admission)
    const reconciliation = await ctx.plugin(Reconciliation)
    await ctx.plugin(Ingress)
    await vi.waitFor(() => {
      expect(ctx.reconciliation.snapshot().lastAttempt).toMatchObject({ source: 'startup', outcome: 'succeeded' })
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
    await disposeContext(ctx)
    await rm(directory, { recursive: true, force: true })
  })

  it('resumes startup reconciliation after restart without changing run identity or order', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-autopilot-reconciliation-restart-'))
    const storagePath = join(directory, 'state.sqlite')
    const secondCandidate = {
      ...candidate,
      issueId: trackerIssueId('issue-2'),
      displayKey: 'FIX-2',
      priorityRank: 2,
      readiness: { ...candidate.readiness, generation: readinessGeneration('transition-2') },
    }
    const first = await mountHostServices(storagePath, { 'dsh-autopilot': { trackerProvider: 'fixture' } })
    await first.plugin(Tracker)
    first.tracker.register(createFixtureTrackerProvider({ issues: [secondCandidate, candidate] }))
    await first.plugin(AutopilotConfig)
    await first.plugin(Admission)
    await first.plugin(Reconciliation)
    await vi.waitFor(() => {
      expect(first.reconciliation.snapshot().lastAttempt).toMatchObject({ source: 'startup', outcome: 'succeeded' })
    })
    const before = first.admission.snapshot().runs
    await disposeContext(first)

    const second = await mountHostServices(storagePath, { 'dsh-autopilot': { trackerProvider: 'fixture' } })
    await second.plugin(Tracker)
    second.tracker.register(createFixtureTrackerProvider({ issues: [candidate, secondCandidate] }))
    await second.plugin(AutopilotConfig)
    await second.plugin(Admission)
    await second.plugin(Reconciliation)
    await vi.waitFor(() => {
      expect(second.reconciliation.snapshot().lastAttempt).toMatchObject({ source: 'startup', outcome: 'succeeded' })
    })

    expect(second.admission.snapshot().runs).toEqual(before)
    await disposeContext(second)
    await rm(directory, { recursive: true, force: true })
  })

  it('exposes bounded provider diagnostics without leaking upstream details', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-autopilot-reconciliation-diagnostic-'))
    const ctx = await mountHostServices(join(directory, 'state.sqlite'), {
      'dsh-autopilot': { trackerProvider: 'fixture' },
    })
    await ctx.plugin(Tracker)
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues: [],
        readCandidates: () =>
          Promise.reject(new TrackerProviderError('rate-limit', 'secret upstream ticket response', 3_000)),
      }),
    )
    await ctx.plugin(AutopilotConfig)
    await ctx.plugin(Admission)
    await ctx.plugin(Reconciliation)
    await vi.waitFor(() => {
      expect(ctx.reconciliation.snapshot().lastAttempt).toMatchObject({
        source: 'startup',
        outcome: 'failed',
        failure: {
          code: 'rate-limit',
          message: 'Tracker rate limiting deferred reconciliation.',
          retryAfterMs: 3_000,
        },
      })
    })
    expect(JSON.stringify(ctx.reconciliation.snapshot())).not.toContain('secret upstream ticket response')

    await disposeContext(ctx)
    await rm(directory, { recursive: true, force: true })
  })
})
