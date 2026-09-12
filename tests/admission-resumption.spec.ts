import { describe, expect, it } from 'vitest'
import type { RunId } from '../src/admission.js'
import { createFixtureTrackerProvider } from '../src/testing.js'
import { readinessGeneration, trackerBindingId, trackerCommentId, trackerIssueId } from '../src/tracker.js'
import {
  boot,
  briefComment,
  candidate,
  databasePath,
  disposeTrackedContext,
  fixtureProvider,
  validBrief,
} from './admission-fixtures.js'
import { fixtureCompositionClaim, fixtureExecutionSettings } from './dsh-fixtures.js'

describe('admission holds and resumption', () => {
  it('durably holds queued work before allocation and excludes it from claims', async () => {
    const path = await databasePath()
    const executionSettings = fixtureExecutionSettings('/tmp/fixture-target', '/tmp/fixture-worktrees')
    const first = await boot(path, [candidate()], 20, executionSettings)
    await first.ctx.admission.reconcile({ source: 'manual' })
    const queued = first.ctx.admission.snapshot().runs[0]
    if (queued?.state !== 'queued') throw new Error('expected a queued run')

    const held = await first.ctx.admission.holdQueued(queued.runId)

    expect(held).toEqual({
      ...queued,
      state: 'paused',
      queueClass: 'resumption',
      pause: {
        kind: 'queued',
        reason: 'operator',
        operatorHold: true,
        continuationTarget: 'implementing',
        pausedAt: expect.any(String),
      },
    })
    expect(Date.parse(held.pause.pausedAt)).not.toBeNaN()
    expect(held).not.toHaveProperty('execution')
    expect(held).not.toHaveProperty('budget')
    expect(first.ctx.admission.snapshot().budget).toEqual({
      reservedTokens: 0,
      settledTokens: 0,
      usageUncertain: false,
    })
    await expect(first.ctx.admission.claimNext(fixtureCompositionClaim())).resolves.toBeUndefined()

    ;(held.pause as { reason: string }).reason = 'caller mutation'
    ;(held.brief as { content: string }).content = 'caller mutation'
    const beforeRestart = first.ctx.admission.snapshot()
    expect(beforeRestart.runs[0]).toMatchObject({
      state: 'paused',
      queueClass: 'resumption',
      brief: { content: validBrief },
      pause: { reason: 'operator', operatorHold: true, continuationTarget: 'implementing' },
    })
    await disposeTrackedContext(first.ctx)

    const second = await boot(path, [], 20, executionSettings)
    expect(second.ctx.admission.snapshot()).toEqual(beforeRestart)
    await expect(second.ctx.admission.claimNext(fixtureCompositionClaim())).resolves.toBeUndefined()
  })

  it('rejects invalid, absent, paused, and active hold targets atomically', async () => {
    const { ctx } = await boot(
      await databasePath(),
      [
        candidate({ issueId: trackerIssueId('active'), displayKey: 'FIX-ACTIVE', priorityRank: 1 }),
        candidate({ issueId: trackerIssueId('paused'), displayKey: 'FIX-PAUSED', priorityRank: 2 }),
      ],
      20,
      fixtureExecutionSettings('/tmp/fixture-target', '/tmp/fixture-worktrees'),
    )
    await ctx.admission.reconcile({ source: 'manual' })
    const [, queuedToPause] = ctx.admission.snapshot().runs
    if (queuedToPause?.state !== 'queued') throw new Error('expected a second queued run')
    const paused = await ctx.admission.holdQueued(queuedToPause.runId)
    const active = await ctx.admission.claimNext(fixtureCompositionClaim())
    if (active === undefined) throw new Error('expected an implementing run')
    const before = ctx.admission.snapshot()

    await expect(ctx.admission.holdQueued('not-a-run-id' as RunId)).rejects.toThrow()
    expect(ctx.admission.snapshot()).toEqual(before)
    await expect(ctx.admission.holdQueued(`run_${'0'.repeat(32)}` as RunId)).rejects.toThrow(/does not exist/)
    expect(ctx.admission.snapshot()).toEqual(before)
    await expect(ctx.admission.holdQueued(paused.runId)).rejects.toThrow(/not queued/)
    expect(ctx.admission.snapshot()).toEqual(before)
    await expect(ctx.admission.holdQueued(active.runId)).rejects.toThrow(/not queued/)
    expect(ctx.admission.snapshot()).toEqual(before)
  })

  it('resumes the same run and Brief ahead of higher-priority new work', async () => {
    const resumedIssue = candidate({
      issueId: trackerIssueId('resume'),
      displayKey: 'FIX-RESUME',
      priorityRank: 9,
      readiness: {
        kind: 'transition',
        generation: readinessGeneration('transition-resume'),
        actorId: 'person-1',
        actorKind: 'human',
        occurredAt: '2026-09-11T00:00:00.000Z',
      },
    })
    const newIssue = candidate({
      issueId: trackerIssueId('new'),
      displayKey: 'FIX-NEW',
      priorityRank: 1,
      readiness: {
        kind: 'transition',
        generation: readinessGeneration('transition-new'),
        actorId: 'person-1',
        actorKind: 'human',
        occurredAt: '2026-09-11T00:00:00.000Z',
      },
    })
    const { ctx, disposeProvider } = await boot(
      await databasePath(),
      [resumedIssue],
      20,
      fixtureExecutionSettings('/tmp/fixture-target', '/tmp/fixture-worktrees', {
        deploymentTokenCap: 120,
      }),
    )
    await ctx.admission.reconcile({ source: 'manual' })
    const admitted = ctx.admission.snapshot().runs[0]
    if (admitted?.state !== 'queued') throw new Error('expected a queued run')
    await ctx.admission.holdQueued(admitted.runId)
    await disposeProvider()
    ctx.tracker.register(fixtureProvider([resumedIssue, newIssue]))
    await ctx.admission.reconcile({ source: 'manual' })

    expect(ctx.admission.snapshot().runs.map((run) => [run.displayKey, run.queueClass])).toEqual([
      ['FIX-NEW', 'new'],
      ['FIX-RESUME', 'resumption'],
    ])

    const resumed = await ctx.admission.resumeRun(admitted.runId)

    expect(resumed).toEqual({
      runId: 'run_2a43c5f5acb4d19acd9c606915e90a79',
      providerId: 'fixture',
      bindingId: 'fixture:project',
      issueId: 'resume',
      displayKey: 'FIX-RESUME',
      summary: 'Implement durable tracker admission',
      priorityRank: 9,
      readinessGeneration: 'transition-resume',
      brief: {
        commentId: 'comment-1',
        updatedAt: '2026-09-11T00:00:00.000Z',
        digest: '91b0486a0b355a6c11a84b3511ca2703c00d35e09a0a52a5e6ccd8140cb19c32',
        content: validBrief,
      },
      deliveries: [],
      state: 'queued',
      queueClass: 'resumption',
      queuedAt: expect.any(String),
      queueSequence: 1,
    })
    expect(ctx.admission.snapshot().runs.map((run) => [run.displayKey, run.state, run.queueClass])).toEqual([
      ['FIX-RESUME', 'queued', 'resumption'],
      ['FIX-NEW', 'queued', 'new'],
    ])
    const claimed = await ctx.admission.claimNext(fixtureCompositionClaim())
    expect(claimed).toMatchObject({
      runId: 'run_2a43c5f5acb4d19acd9c606915e90a79',
      displayKey: 'FIX-RESUME',
      queueClass: 'resumption',
      state: 'implementing',
      brief: {
        commentId: 'comment-1',
        updatedAt: '2026-09-11T00:00:00.000Z',
        digest: '91b0486a0b355a6c11a84b3511ca2703c00d35e09a0a52a5e6ccd8140cb19c32',
        content: validBrief,
      },
    })
    expect(ctx.admission.snapshot().runs.find((run) => run.displayKey === 'FIX-RESUME')).toMatchObject({
      state: 'implementing',
      queueClass: 'resumption',
      queueSequence: 1,
    })
    expect(ctx.admission.snapshot().runs.find((run) => run.displayKey === 'FIX-NEW')).toMatchObject({
      state: 'queued',
      queueClass: 'new',
      queueSequence: 2,
    })
  })

  it.each([
    {
      name: 'readiness generation changed',
      issue: candidate({
        readiness: {
          kind: 'transition',
          generation: readinessGeneration('transition-2'),
          actorId: 'person-1',
          actorKind: 'human',
          occurredAt: '2026-09-11T00:01:00.000Z',
        },
      }),
    },
    { name: 'issue is no longer ready', issue: candidate({ isReady: false }) },
    {
      name: 'provider binding changed',
      issue: candidate({ bindingId: trackerBindingId('fixture:other-project') }),
    },
    { name: 'issue identity changed', issue: candidate({ issueId: trackerIssueId('issue-2') }) },
    {
      name: 'Brief identity changed',
      issue: candidate({ comments: [briefComment({ id: trackerCommentId('comment-2') })] }),
    },
    {
      name: 'Brief version changed',
      issue: candidate({
        comments: [briefComment({ updatedAt: '2026-09-11T00:01:00.000Z' })],
        readiness: {
          kind: 'transition',
          generation: readinessGeneration('transition-1'),
          actorId: 'person-1',
          actorKind: 'human',
          occurredAt: '2026-09-11T00:02:00.000Z',
        },
      }),
    },
    {
      name: 'Brief content changed',
      issue: candidate({
        comments: [
          briefComment({
            body: validBrief.replace('Implement durable tracker admission.', 'Implement changed tracker admission.'),
          }),
        ],
      }),
    },
  ])('leaves the operator hold unchanged when the current $name', async ({ issue }) => {
    const { ctx, disposeProvider } = await boot(await databasePath(), [candidate()])
    await ctx.admission.reconcile({ source: 'manual' })
    const admitted = ctx.admission.snapshot().runs[0]
    if (admitted?.state !== 'queued') throw new Error('expected a queued run')
    await ctx.admission.holdQueued(admitted.runId)
    await disposeProvider()
    ctx.tracker.register(fixtureProvider([issue]))
    const before = ctx.admission.snapshot()

    await expect(ctx.admission.resumeRun(admitted.runId)).rejects.toThrow(/cannot be resumed/i)

    expect(ctx.admission.snapshot()).toEqual(before)
    expect(ctx.admission.snapshot().runs).toMatchObject([
      {
        runId: 'run_6e263a17084c6d6de5a1dbe4908cd269',
        state: 'paused',
        queueClass: 'resumption',
        pause: { reason: 'operator', operatorHold: true, continuationTarget: 'implementing' },
      },
    ])
  })

  it('rechecks scheduler enablement after tracker revalidation without clearing the hold', async () => {
    const issue = candidate()
    const { ctx, disposeProvider } = await boot(await databasePath(), [issue])
    await ctx.admission.reconcile({ source: 'manual' })
    const admitted = ctx.admission.snapshot().runs[0]
    if (admitted?.state !== 'queued') throw new Error('expected a queued run')
    await ctx.admission.holdQueued(admitted.runId)
    await disposeProvider()

    let signalReadStarted: (() => void) | undefined
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve
    })
    let releaseRead: (() => void) | undefined
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues: [issue],
        readCandidates: async () => {
          signalReadStarted?.()
          await readReleased
          return { issues: [issue] }
        },
      }),
    )

    const resume = ctx.admission.resumeRun(admitted.runId)
    await readStarted
    await ctx.admission.setSchedulerMode('draining')
    releaseRead?.()
    await expect(resume).rejects.toThrow(/scheduler.*enabled/i)

    expect(ctx.admission.snapshot()).toMatchObject({
      scheduler: { mode: 'draining' },
      runs: [
        {
          runId: 'run_6e263a17084c6d6de5a1dbe4908cd269',
          state: 'paused',
          queueClass: 'resumption',
          pause: { reason: 'operator', operatorHold: true },
        },
      ],
    })
  })

  it('rechecks current Brief policy after tracker revalidation without clearing the hold', async () => {
    const issue = candidate({
      comments: [briefComment({ body: validBrief.replace('Issue #6 defines the product slice.', 'x'.repeat(1500)) })],
    })
    const { ctx, disposeProvider } = await boot(await databasePath(), [issue])
    await ctx.admission.reconcile({ source: 'manual' })
    const admitted = ctx.admission.snapshot().runs[0]
    if (admitted?.state !== 'queued') throw new Error('expected a queued run')
    await ctx.admission.holdQueued(admitted.runId)
    await disposeProvider()

    let signalReadStarted: (() => void) | undefined
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve
    })
    let releaseRead: (() => void) | undefined
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues: [issue],
        readCandidates: async () => {
          signalReadStarted?.()
          await readReleased
          return { issues: [issue] }
        },
      }),
    )

    const resume = ctx.admission.resumeRun(admitted.runId)
    await readStarted
    await ctx.settings.update('dsh-autopilot', { maxBriefBytes: 1024 })
    releaseRead?.()
    await expect(resume).rejects.toThrow(/Brief|eligibility|policy/i)

    expect(ctx.admission.snapshot().runs).toMatchObject([
      {
        runId: admitted.runId,
        state: 'paused',
        queueClass: 'resumption',
        pause: { reason: 'operator', operatorHold: true },
      },
    ])
  })
})
