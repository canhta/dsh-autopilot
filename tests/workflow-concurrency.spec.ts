import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Reconciliation } from '../src/reconciliation.js'
import { readinessGeneration, trackerIssueId } from '../src/tracker.js'
import { bootFixture, ControlledAdapter, candidate, temporaryDirectories } from './dispatch-fixtures.js'
import { Deferred } from './dsh-fixtures.js'

describe('workflow execution concurrency', () => {
  it('fills available slots and drains queued work after one reconciliation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-workflow-fill-'))
    temporaryDirectories.push(root)
    const release = new Deferred<void>()
    let requests = 0
    const adapter = new ControlledAdapter('failed', 'known', 'multiple')
    adapter.beforeResponse = async () => {
      requests += 1
      await release.promise
    }
    const issues = [
      candidate(),
      candidate({
        issueId: trackerIssueId('issue-8-fill-second'),
        displayKey: 'FIX-8-FILL-SECOND',
        readiness: {
          kind: 'transition',
          generation: readinessGeneration('transition-8-fill-second'),
          actorId: 'person-1',
          actorKind: 'human',
          occurredAt: '2026-09-11T00:00:01.000Z',
        },
      }),
      candidate({
        issueId: trackerIssueId('issue-8-fill-third'),
        displayKey: 'FIX-8-FILL-THIRD',
        readiness: {
          kind: 'transition',
          generation: readinessGeneration('transition-8-fill-third'),
          actorId: 'person-1',
          actorKind: 'human',
          occurredAt: '2026-09-11T00:00:02.000Z',
        },
      }),
    ]
    const ctx = await bootFixture(root, adapter, issues, {
      maxRunning: 2,
      deploymentTokenCap: 180,
    })

    try {
      await ctx.autopilotWorkflow.reconcile('startup')
      await expect.poll(() => requests).toBe(2)

      release.resolve()
      await expect.poll(() => requests).toBeGreaterThanOrEqual(3)
    } finally {
      release.resolve()
    }
  })

  it('executes two runs concurrently without exceeding maxRunning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-workflow-concurrency-'))
    temporaryDirectories.push(root)
    const release = new Deferred<void>()
    let requests = 0
    const adapter = new ControlledAdapter()
    adapter.beforeResponse = async () => {
      requests += 1
      await release.promise
    }
    const issues = [
      candidate(),
      candidate({
        issueId: trackerIssueId('issue-8-second'),
        displayKey: 'FIX-8-SECOND',
        readiness: {
          kind: 'transition',
          generation: readinessGeneration('transition-8-second'),
          actorId: 'person-1',
          actorKind: 'human',
          occurredAt: '2026-09-11T00:00:01.000Z',
        },
      }),
      candidate({
        issueId: trackerIssueId('issue-8-third'),
        displayKey: 'FIX-8-THIRD',
        readiness: {
          kind: 'transition',
          generation: readinessGeneration('transition-8-third'),
          actorId: 'person-1',
          actorKind: 'human',
          occurredAt: '2026-09-11T00:00:02.000Z',
        },
      }),
    ]
    const ctx = await bootFixture(root, adapter, issues, {
      maxRunning: 2,
      deploymentTokenCap: 180,
    })
    await expect(ctx.settings.update('dsh-autopilot', { maxRunning: 0 })).rejects.toThrow()

    const first = ctx.dispatch.dispatchNext()
    const second = ctx.dispatch.dispatchNext()
    const capacityLimited = ctx.dispatch.dispatchNext()
    try {
      await expect.poll(() => requests).toBe(2)
      await expect(capacityLimited).resolves.toBeUndefined()
      expect(requests).toBe(2)
      expect(
        ctx.admission
          .snapshot()
          .runs.map((run) => run.state)
          .sort(),
      ).toEqual(['implementing', 'implementing', 'queued'])
    } finally {
      release.resolve()
      await Promise.allSettled([first, second, capacityLimited])
    }
  })

  it('completes a timed reconciliation while an execution remains active', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-workflow-poll-'))
    temporaryDirectories.push(root)
    const started = new Deferred<void>()
    const release = new Deferred<void>()
    const ctx = await bootFixture(
      root,
      new ControlledAdapter('verified', 'known', 'valid', async () => {
        started.resolve()
        await release.promise
      }),
      undefined,
      { maxRunning: 1 },
    )
    const execution = ctx.dispatch.dispatchNext()
    await started.promise
    try {
      await ctx.plugin(Reconciliation)
      await expect
        .poll(() => ctx.autopilotReconciliation.snapshot().lastAttempt)
        .toMatchObject({
          source: 'startup',
          outcome: 'succeeded',
        })
      expect(ctx.admission.snapshot().runs[0]).toMatchObject({ state: 'implementing' })
    } finally {
      release.resolve()
      await execution
    }
  })
})
