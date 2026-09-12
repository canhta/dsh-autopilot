import { describe, expect, it, vi } from 'vitest'
import { createFixtureTrackerProvider } from '../src/testing.js'
import { readinessGeneration, trackerIssueId, trackerProviderId } from '../src/tracker.js'
import { Deferred } from './dsh-fixtures.js'
import { candidate, createHarness, mountReconciliation } from './reconciliation-fixtures.js'

describe('reconciliation service seam: lifecycle', () => {
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
})
