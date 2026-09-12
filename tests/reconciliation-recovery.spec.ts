import { describe, expect, it, vi } from 'vitest'
import { Admission } from '../src/admission.js'
import { AutopilotConfig } from '../src/config.js'
import { TRACKER_INGRESS_PATH } from '../src/ingress.js'
import { Reconciliation } from '../src/reconciliation.js'
import { createFixtureTrackerProvider } from '../src/testing.js'
import { readinessGeneration, Tracker, TrackerProviderError, trackerIssueId } from '../src/tracker.js'
import { Deferred, mountHostServices } from './dsh-fixtures.js'
import {
  candidate,
  contexts,
  createHarness,
  disposeTrackedContext,
  mountIngress,
  mountReconciliation,
} from './reconciliation-fixtures.js'

describe('reconciliation service seam: overload and recovery', () => {
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
