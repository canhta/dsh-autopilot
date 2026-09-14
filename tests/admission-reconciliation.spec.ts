import { describe, expect, it } from 'vitest'
import { Admission, AdmissionIngressError } from '../src/admission.js'
import { AutopilotConfig } from '../src/config.js'
import { createFixtureTrackerProvider } from '../src/testing.js'
import { readinessGeneration, Tracker, TrackerProviderError, trackerCommentId, trackerIssueId } from '../src/tracker.js'
import {
  boot,
  briefComment,
  candidate,
  databasePath,
  disposeTrackedContext,
  trackContext,
  validBrief,
} from './admission-fixtures.js'
import { Deferred, fixtureCompositionClaim, fixtureExecutionSettings, mountHostServices } from './dsh-fixtures.js'

describe('admission reconciliation and policy', () => {
  it('keeps dispatch disabled unless native execution and positive limits are explicit', async () => {
    const { ctx } = await boot(await databasePath(), [candidate()])
    await ctx.admission.reconcile({ source: 'manual' })

    await expect(ctx.admission.claimNext(fixtureCompositionClaim())).rejects.toThrow(/dispatch is disabled/)

    expect(ctx.admission.snapshot()).toMatchObject({
      runs: [{ state: 'queued' }],
      budget: { reservedTokens: 0, settledTokens: 0, usageUncertain: false },
    })
  })

  it('atomically claims one run without oversubscribing the deployment token cap', async () => {
    const { ctx } = await boot(
      await databasePath(),
      [
        candidate({ issueId: trackerIssueId('first'), displayKey: 'FIX-1', priorityRank: 1 }),
        candidate({ issueId: trackerIssueId('second'), displayKey: 'FIX-2', priorityRank: 2 }),
      ],
      20,
      fixtureExecutionSettings('/tmp/fixture-target', '/tmp/fixture-worktrees', { perRunTokenCap: 100 }),
    )
    await ctx.admission.reconcile({ source: 'manual' })

    const claims = await Promise.allSettled([
      ctx.admission.claimNext(fixtureCompositionClaim()),
      ctx.admission.claimNext(fixtureCompositionClaim()),
    ])

    expect(claims.filter((claim) => claim.status === 'fulfilled')).toHaveLength(1)
    expect(claims.filter((claim) => claim.status === 'rejected')).toMatchObject([
      { reason: { message: expect.stringMatching(/deployment token cap/i) } },
    ])
    expect(ctx.admission.snapshot()).toMatchObject({
      budget: { reservedTokens: 60, settledTokens: 0, usageUncertain: false },
      runs: [
        {
          displayKey: 'FIX-1',
          state: 'implementing',
          execution: {
            attempt: 1,
            sessionId: expect.stringMatching(/^autopilot-run_/),
            worktreePath: expect.stringMatching(/[/\\]run_[a-f0-9]{32}$/),
          },
          budget: { capTokens: 100, reservedTokens: 60 },
        },
        { displayKey: 'FIX-2', state: 'queued' },
      ],
    })
  })

  it('commits duplicate and competing reconciliation as one queued run', async () => {
    const { ctx } = await boot(await databasePath(), [candidate()])

    await Promise.all([
      ctx.admission.reconcile({ source: 'webhook', deliveryId: 'fixture:delivery-1' }),
      ctx.admission.reconcile({ source: 'scheduled' }),
    ])

    const snapshot = ctx.admission.snapshot()
    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.runs[0]).toMatchObject({
      displayKey: 'FIX-1',
      state: 'queued',
      readinessGeneration: 'transition-1',
      brief: { commentId: 'comment-1' },
    })
    expect(snapshot.acceptedIngress).toContain('fixture:delivery-1')
  })

  it('cancels the active provider read when reconciliation is cancelled without mutating admission', async () => {
    const { ctx, disposeProvider } = await boot(await databasePath(), [])
    await disposeProvider()
    const readStarted = new Deferred<void>()
    const callerCancelled = new Error('reconciliation owner disposed')
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues: [candidate()],
        readCandidates: async ({ signal }) => {
          readStarted.resolve()
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
          return { issues: [candidate()] }
        },
      }),
    )
    const controller = new AbortController()
    const before = ctx.admission.snapshot()

    const reconciliation = ctx.admission.reconcile({ source: 'scheduled', signal: controller.signal })
    await readStarted.promise
    controller.abort(callerCancelled)

    await expect(reconciliation).rejects.toBe(callerCancelled)
    expect(ctx.admission.snapshot()).toEqual(before)
  })

  it('cancels provider ingress verification when its admission caller is cancelled', async () => {
    const { ctx, disposeProvider } = await boot(await databasePath(), [])
    await disposeProvider()
    const verificationStarted = new Deferred<void>()
    const callerCancelled = new Error('ingress owner disposed')
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues: [candidate()],
        verifyIngress: async ({ signal }) => {
          verificationStarted.resolve()
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
          return { deliveryId: 'fixture:unreachable' }
        },
      }),
    )
    const controller = new AbortController()
    const before = ctx.admission.snapshot()

    const reconciliation = ctx.admission.reconcileIngress(
      { method: 'POST', headers: [], body: new Uint8Array() },
      controller.signal,
    )
    await verificationStarted.promise
    controller.abort(callerCancelled)

    await expect(reconciliation).rejects.toBe(callerCancelled)
    expect(ctx.admission.snapshot()).toEqual(before)
  })

  it('does not reconsider an already accepted webhook delivery', async () => {
    const path = await databasePath()
    const first = await boot(path, [candidate()])
    await first.ctx.admission.reconcile({ source: 'webhook', deliveryId: 'fixture:delivery-1' })
    await disposeTrackedContext(first.ctx)

    const second = await boot(path, [
      candidate({
        readiness: {
          kind: 'transition',
          generation: readinessGeneration('transition-2'),
          actorId: 'person-1',
          actorKind: 'human',
          occurredAt: '2026-09-11T00:01:00.000Z',
        },
      }),
    ])
    const result = await second.ctx.admission.reconcile({
      source: 'webhook',
      deliveryId: 'fixture:delivery-1',
    })

    expect(result.decisions).toEqual([])
    expect(result.revision).toBe(1)
    expect(result.runs.map((run) => run.readinessGeneration)).toEqual(['transition-1'])
  })

  it('orders newly queued work by priority and stable identity', async () => {
    const low = candidate({ issueId: trackerIssueId('issue-low'), displayKey: 'FIX-3', priorityRank: 3 })
    const highB = candidate({ issueId: trackerIssueId('issue-high-b'), displayKey: 'FIX-2', priorityRank: 1 })
    const highA = candidate({ issueId: trackerIssueId('issue-high-a'), displayKey: 'FIX-1', priorityRank: 1 })
    const { ctx } = await boot(await databasePath(), [low, highB, highA])

    await ctx.admission.reconcile({ source: 'manual' })

    expect(ctx.admission.snapshot().runs.map((run) => run.displayKey)).toEqual(['FIX-1', 'FIX-2', 'FIX-3'])
  })

  it('reports policy denials and leaves overflow unqueued', async () => {
    const ambiguous = candidate({
      issueId: trackerIssueId('ambiguous'),
      displayKey: 'FIX-AMB',
      comments: [briefComment(), briefComment({ id: trackerCommentId('comment-2') })],
    })
    const unknownDependency = candidate({
      issueId: trackerIssueId('dependency'),
      displayKey: 'FIX-DEP',
      dependencies: [{ issueId: trackerIssueId('blocked-by'), displayKey: 'FIX-0', state: 'unknown' }],
    })
    const automation = candidate({
      issueId: trackerIssueId('automation'),
      displayKey: 'FIX-BOT',
      readiness: {
        kind: 'transition',
        generation: readinessGeneration('bot-transition'),
        actorId: 'integration-account',
        actorKind: 'automation',
        occurredAt: '2026-09-11T00:00:00.000Z',
      },
    })
    const eligible = candidate({ issueId: trackerIssueId('eligible'), displayKey: 'FIX-OK' })
    const overflow = candidate({ issueId: trackerIssueId('overflow'), displayKey: 'FIX-FULL' })
    const { ctx } = await boot(await databasePath(), [ambiguous, unknownDependency, automation, eligible, overflow], 1)

    const result = await ctx.admission.reconcile({ source: 'manual' })

    expect(result.decisions).toEqual([
      { displayKey: 'FIX-AMB', outcome: 'rejected', reason: 'ambiguous-brief' },
      { displayKey: 'FIX-DEP', outcome: 'rejected', reason: 'dependency-unknown' },
      { displayKey: 'FIX-BOT', outcome: 'rejected', reason: 'human-readiness-required' },
      { displayKey: 'FIX-OK', outcome: 'queued' },
      { displayKey: 'FIX-FULL', outcome: 'deferred', reason: 'queue-capacity' },
    ])
    expect(ctx.admission.snapshot().runs.map((run) => run.displayKey)).toEqual(['FIX-OK'])
  })

  it('gives queue capacity to higher-priority eligible work', async () => {
    const low = candidate({ issueId: trackerIssueId('low'), displayKey: 'FIX-LOW', priorityRank: 3 })
    const high = candidate({ issueId: trackerIssueId('high'), displayKey: 'FIX-HIGH', priorityRank: 1 })
    const { ctx } = await boot(await databasePath(), [low, high], 1)

    const result = await ctx.admission.reconcile({ source: 'manual' })

    expect(ctx.admission.snapshot().runs.map((run) => run.displayKey)).toEqual(['FIX-HIGH'])
    expect(result.decisions).toEqual([
      { displayKey: 'FIX-LOW', outcome: 'deferred', reason: 'queue-capacity' },
      { displayKey: 'FIX-HIGH', outcome: 'queued' },
    ])
  })

  it('does not let retained terminal history consume queue capacity', async () => {
    const first = candidate({ issueId: trackerIssueId('first'), displayKey: 'FIX-1', priorityRank: 1 })
    const second = candidate({ issueId: trackerIssueId('second'), displayKey: 'FIX-2', priorityRank: 2 })
    const { ctx } = await boot(
      await databasePath(),
      [first, second],
      1,
      fixtureExecutionSettings('/tmp/fixture-target', '/tmp/fixture-worktrees'),
    )
    await ctx.admission.reconcile({ source: 'manual' })
    const claimed = await ctx.admission.claimNext(fixtureCompositionClaim())
    if (claimed === undefined) throw new Error('expected the first run to be claimed')
    await ctx.admission.settle(
      claimed.runId,
      { kind: 'failed', summary: 'Fixture terminal history.', evidence: ['fixture'] },
      { kind: 'known', tokens: 1 },
    )

    const result = await ctx.admission.reconcile({ source: 'manual' })

    expect(result.decisions).toEqual([
      { displayKey: 'FIX-1', outcome: 'duplicate' },
      { displayKey: 'FIX-2', outcome: 'queued' },
    ])
    expect(ctx.admission.snapshot().runs.map((run) => [run.displayKey, run.state])).toEqual([
      ['FIX-2', 'queued'],
      ['FIX-1', 'failed'],
    ])
  })

  it('does not consume a webhook receipt while eligible work is deferred by queue capacity', async () => {
    const first = candidate({ issueId: trackerIssueId('first'), displayKey: 'FIX-1', priorityRank: 1 })
    const second = candidate({ issueId: trackerIssueId('second'), displayKey: 'FIX-2', priorityRank: 2 })
    const { ctx } = await boot(await databasePath(), [first, second], 1)

    const failure = await ctx.admission
      .reconcile({ source: 'webhook', deliveryId: 'fixture:capacity-delivery' })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AdmissionIngressError)
    expect(failure).toMatchObject({ code: 'queue-capacity' })
    expect(ctx.admission.snapshot().acceptedIngress).not.toContain('fixture:capacity-delivery')
    expect(ctx.admission.snapshot().runs.map((run) => run.displayKey)).toEqual(['FIX-1'])
  })

  it('classifies non-terminating and overbound provider pagination as invalid responses', async () => {
    const path = await databasePath()
    const ctx = trackContext(
      await mountHostServices(path, {
        'dsh-autopilot': { trackerProvider: 'fixture', maxQueued: 20 },
      }),
    )
    await ctx.plugin(Tracker)
    const repeatedCursor = ctx.tracker.register(
      createFixtureTrackerProvider({
        issues: [],
        readCandidates: () => Promise.resolve({ issues: [], nextCursor: 'same-page' }),
      }),
    )
    await ctx.plugin(AutopilotConfig)
    await ctx.plugin(Admission)

    const repeated = await ctx.admission.reconcile({ source: 'scheduled' }).catch((error: unknown) => error)
    expect(repeated).toBeInstanceOf(TrackerProviderError)
    expect(repeated).toMatchObject({ code: 'invalid-response' })

    await repeatedCursor()
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues: [],
        readCandidates: () => Promise.resolve({ issues: Array.from({ length: 1_001 }, () => candidate()) }),
      }),
    )

    const overbound = await ctx.admission.reconcile({ source: 'scheduled' }).catch((error: unknown) => error)
    expect(overbound).toBeInstanceOf(TrackerProviderError)
    expect(overbound).toMatchObject({ code: 'invalid-response' })
  })

  it('requires current readiness and a transition no older than the selected Brief', async () => {
    const notReady = candidate({
      issueId: trackerIssueId('not-ready'),
      displayKey: 'FIX-NOT-READY',
      isReady: false,
    })
    const editedAfterApproval = candidate({
      issueId: trackerIssueId('edited'),
      displayKey: 'FIX-EDITED',
      comments: [briefComment({ updatedAt: '2026-09-11T00:01:00.000Z' })],
    })
    const offsetMakesTransitionOlder = candidate({
      issueId: trackerIssueId('offset-older'),
      displayKey: 'FIX-OFFSET',
      comments: [briefComment({ updatedAt: '2026-09-11T00:30:00.000Z' })],
      readiness: {
        kind: 'transition',
        generation: readinessGeneration('offset-transition'),
        actorId: 'person-1',
        actorKind: 'human',
        occurredAt: '2026-09-11T01:00:00+02:00',
      },
    })
    const { ctx } = await boot(await databasePath(), [notReady, editedAfterApproval, offsetMakesTransitionOlder])

    const result = await ctx.admission.reconcile({ source: 'manual' })

    expect(result.decisions).toEqual([
      { displayKey: 'FIX-NOT-READY', outcome: 'rejected', reason: 'not-ready' },
      { displayKey: 'FIX-EDITED', outcome: 'rejected', reason: 'human-readiness-required' },
      { displayKey: 'FIX-OFFSET', outcome: 'rejected', reason: 'human-readiness-required' },
    ])
    expect(ctx.admission.snapshot().runs).toEqual([])
  })

  it('rejects empty semantic sections and bounds Briefs by UTF-8 bytes', async () => {
    const emptySections = candidate({
      issueId: trackerIssueId('empty-sections'),
      displayKey: 'FIX-EMPTY',
      comments: [
        briefComment({
          body: '# Agent Brief\n\ndsh-autopilot:brief:v1\n\n## Objective\n\n## In scope\n\n## Acceptance criteria\n\n## Constraints\n\n## Context\n',
        }),
      ],
    })
    const oversized = candidate({
      issueId: trackerIssueId('oversized'),
      displayKey: 'FIX-LARGE',
      comments: [briefComment({ body: `${validBrief}\n${'😀'.repeat(9000)}` })],
    })
    const { ctx } = await boot(await databasePath(), [emptySections, oversized])

    const result = await ctx.admission.reconcile({ source: 'manual' })

    expect(result.decisions).toEqual([
      { displayKey: 'FIX-EMPTY', outcome: 'rejected', reason: 'invalid-brief' },
      { displayKey: 'FIX-LARGE', outcome: 'rejected', reason: 'brief-too-large' },
    ])
  })

  it('accepts exact Brief and summary limits and rejects an oversized summary', async () => {
    const briefPrefix = `${validBrief}\n`
    const exactBrief = `${briefPrefix}${'x'.repeat(32 * 1024 - new TextEncoder().encode(briefPrefix).byteLength)}`
    const exact = candidate({
      issueId: trackerIssueId('exact-limits'),
      displayKey: 'FIX-EXACT',
      summary: 's'.repeat(2048),
      comments: [briefComment({ body: exactBrief })],
    })
    const oversizedSummary = candidate({
      issueId: trackerIssueId('oversized-summary'),
      displayKey: 'FIX-SUMMARY',
      summary: 's'.repeat(2049),
    })
    const { ctx } = await boot(await databasePath(), [exact, oversizedSummary])

    const result = await ctx.admission.reconcile({ source: 'manual' })

    expect(result.decisions).toEqual([
      { displayKey: 'FIX-EXACT', outcome: 'queued' },
      { displayKey: 'FIX-SUMMARY', outcome: 'rejected', reason: 'summary-too-large' },
    ])
  })
})
