import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { createFixtureTrackerProvider } from '../src/testing.js'
import {
  readinessGeneration,
  Tracker,
  type TrackerProvider,
  TrackerProviderError,
  trackerBindingId,
  trackerIssueId,
  trackerProviderId,
} from '../src/tracker.js'
import { Deferred } from './dsh-fixtures.js'

const fixtureIssue = {
  bindingId: trackerBindingId('fixture:project'),
  issueId: trackerIssueId('issue-1'),
  displayKey: 'FIX-1',
  summary: 'Implement fixture admission',
  priorityRank: 1,
  isReady: true,
  labels: ['ready-for-agent'],
  comments: [],
  dependencies: [],
  readiness: {
    kind: 'transition' as const,
    generation: readinessGeneration('transition-1'),
    actorId: 'person-1',
    actorKind: 'human' as const,
    occurredAt: '2026-09-11T00:00:00.000Z',
  },
}

function fixtureProvider(overrides: Partial<TrackerProvider> = {}): TrackerProvider {
  return createFixtureTrackerProvider({ issues: [fixtureIssue], ...overrides })
}

describe('tracker service seam', () => {
  it('reads normalized candidates from an independently mounted provider', async () => {
    const ctx = new Context()
    await ctx.plugin(Tracker)
    const providerFiber = await ctx.plugin({
      inject: ['tracker'],
      apply(providerCtx) {
        providerCtx.effect(() => providerCtx.tracker.register(fixtureProvider()))
      },
    })

    await expect(ctx.tracker.readCandidates(trackerProviderId('fixture'))).resolves.toEqual({
      issues: [fixtureIssue],
    })

    await providerFiber.dispose()
    await expect(ctx.tracker.readCandidates(trackerProviderId('fixture'))).rejects.toMatchObject({
      code: 'provider-unavailable',
    })
  })

  it('rejects duplicate ids and incompatible interface versions', async () => {
    const ctx = new Context()
    await ctx.plugin(Tracker)
    const dispose = ctx.tracker.register(fixtureProvider())

    expect(() => ctx.tracker.register(fixtureProvider())).toThrow(/already registered/)
    expect(() =>
      ctx.tracker.register({
        ...fixtureProvider(),
        interfaceVersion: 2 as never,
      }),
    ).toThrow(/interface version/)

    await dispose()
  })

  it('aborts and drains provider work before withdrawal completes', async () => {
    const ctx = new Context()
    await ctx.plugin(Tracker)
    let observedAbort = false
    const dispose = ctx.tracker.register(
      fixtureProvider({
        readCandidates: async ({ signal }) => {
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                observedAbort = true
                resolve()
              },
              { once: true },
            )
          })
          throw new TrackerProviderError('transient', 'fixture request was cancelled')
        },
      }),
    )

    const read = ctx.tracker.readCandidates(trackerProviderId('fixture'))
    await dispose()

    expect(observedAbort).toBe(true)
    await expect(read).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('fences a late successful result before withdrawal, remount, and consumer state mutation', async () => {
    const ctx = new Context()
    await ctx.plugin(Tracker)
    const readStarted = new Deferred<void>()
    const releaseRead = new Deferred<void>()
    let consumerWrites = 0
    const dispose = ctx.tracker.register(
      fixtureProvider({
        readCandidates: async () => {
          readStarted.resolve()
          await releaseRead.promise
          return { issues: [fixtureIssue] }
        },
      }),
    )
    const read = ctx.tracker.withProvider(trackerProviderId('fixture'), async (reader) => {
      const page = await reader.readCandidates()
      consumerWrites += 1
      return page
    })
    await readStarted.promise

    const withdrawing = dispose()
    releaseRead.resolve()

    await expect(read).rejects.toMatchObject({ code: 'provider-unavailable' })
    await withdrawing
    expect(consumerWrites).toBe(0)
    const disposeReplacement = ctx.tracker.register(fixtureProvider())
    await expect(ctx.tracker.readCandidates(trackerProviderId('fixture'))).resolves.toEqual({ issues: [fixtureIssue] })
    expect(consumerWrites).toBe(0)
    await disposeReplacement()
  })

  it('does not relabel consumer failures as tracker failures', async () => {
    const ctx = new Context()
    await ctx.plugin(Tracker)
    ctx.tracker.register(fixtureProvider())
    const consumerFailure = new Error('durable update failed')

    await expect(
      ctx.tracker.withProvider(trackerProviderId('fixture'), async (reader) => {
        await reader.readCandidates()
        throw consumerFailure
      }),
    ).rejects.toBe(consumerFailure)
  })
})
