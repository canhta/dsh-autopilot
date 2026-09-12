import { describe, expect, it } from 'vitest'
import { cleanupRejections } from '../src/operations/inspection.js'
import { boot, candidate, databasePath, disposeTrackedContext } from './admission-fixtures.js'
import { fixtureCompositionClaim, fixtureExecutionSettings } from './dsh-fixtures.js'

const queuedRequestId = '635385be-bbbb-4c38-8fb6-54a76dd14c61'
const activeRequestId = '6b4364c6-3bd1-46cd-b2ae-02cd70100cc4'
const blockedRequestId = 'fb852934-a28d-416f-8929-d7f7614f24c9'

describe('admission cancellation', () => {
  it('durably cancels queued work without tracker authorization or unchanged-readiness re-admission', async () => {
    const path = await databasePath()
    let providerReads = 0
    const first = await boot(path, [candidate()], 20, {}, () => {
      providerReads += 1
    })
    await first.ctx.admission.reconcile({ source: 'manual' })
    const queued = first.ctx.admission.snapshot().runs[0]
    if (queued?.state !== 'queued') throw new Error('expected a queued run')

    const cancelled = await first.ctx.admission.cancelRun(queued.runId, queuedRequestId)

    expect(cancelled).toEqual({
      ...queued,
      state: 'cancelled',
      cancellation: {
        requestId: queuedRequestId,
        cancelledAt: expect.any(String),
        from: 'queued',
      },
    })
    expect(providerReads).toBe(1)
    expect(first.ctx.admission.trackerSwitchBlocker('fixture')).toBeUndefined()

    const revision = first.ctx.admission.snapshot().revision
    await expect(first.ctx.admission.cancelRun(queued.runId, queuedRequestId)).resolves.toEqual(cancelled)
    expect(first.ctx.admission.snapshot().revision).toBe(revision)
    await expect(first.ctx.admission.cancelRun(queued.runId, '98b30855-986c-4039-96bd-0e636b1df613')).rejects.toThrow(
      /already cancelled by another request/,
    )
    expect(first.ctx.admission.snapshot().revision).toBe(revision)

    const reconciled = await first.ctx.admission.reconcile({ source: 'manual' })
    expect(reconciled.decisions).toEqual([{ displayKey: queued.displayKey, outcome: 'duplicate' }])
    expect(reconciled.runs).toEqual([cancelled])
    expect(providerReads).toBe(2)
    await disposeTrackedContext(first.ctx)

    const second = await boot(path, [])
    expect(second.ctx.admission.snapshot().runs).toEqual([cancelled])
    await expect(second.ctx.admission.claimNext(fixtureCompositionClaim())).resolves.toBeUndefined()
  })

  it('rejects active cancellation until the allocated run has a durable quiescent checkpoint', async () => {
    const path = await databasePath()
    const settings = fixtureExecutionSettings('/tmp/fixture-target', '/tmp/fixture-worktrees')
    const first = await boot(path, [candidate()], 20, settings)
    await first.ctx.admission.reconcile({ source: 'manual' })
    const implementing = await first.ctx.admission.claimNext(fixtureCompositionClaim())
    if (implementing === undefined) throw new Error('expected an implementing run')

    const beforeCancellation = first.ctx.admission.snapshot()
    await expect(first.ctx.admission.cancelRun(implementing.runId, activeRequestId)).rejects.toThrow(
      /cannot be cancelled from implementing/,
    )
    expect(first.ctx.admission.snapshot()).toEqual(beforeCancellation)

    await first.ctx.admission.requestRunPause(implementing.runId)
    await expect(first.ctx.admission.cancelRun(implementing.runId, activeRequestId)).rejects.toThrow(
      /cannot be cancelled from pausing/,
    )
    const paused = await first.ctx.admission.checkpointPaused(
      implementing.runId,
      { baseHead: 'a'.repeat(40), head: 'b'.repeat(40), status: ' M retained.txt\n' },
      { kind: 'known', tokens: 12 },
    )

    const cancelled = await first.ctx.admission.cancelRun(paused.runId, activeRequestId)
    if (!('execution' in cancelled) || !('budget' in cancelled)) {
      throw new Error('expected an allocated cancelled run')
    }

    expect(cancelled).toEqual({
      ...paused,
      state: 'cancelled',
      cancellation: {
        requestId: activeRequestId,
        cancelledAt: expect.any(String),
        from: 'paused-active',
      },
    })
    expect(cancelled.execution).toEqual(paused.execution)
    expect(cancelled.budget).toEqual(paused.budget)
    expect(cancelled.deliveries).toEqual(paused.deliveries)
    expect(first.ctx.admission.snapshot().budget).toEqual({
      reservedTokens: 0,
      settledTokens: 12,
      usageUncertain: false,
    })

    const cleanup = cleanupRejections({
      run: cancelled,
      disposition: { state: 'unknown', reason: 'not inspected' },
      ownership: true,
      missing: false,
      dirtyFiles: [],
      untrackedFiles: [],
      unpushedCommits: 0,
      now: Date.now(),
    })
    expect(cleanup).toContain('external-intent-unresolved')
    expect(cleanup).toContain('pr-unknown')
    expect(cleanup).toContain('retention-not-met')
    expect(cleanup).not.toContain('run-paused')

    await disposeTrackedContext(first.ctx)
    const second = await boot(path, [], 20, settings)
    expect(second.ctx.admission.snapshot().runs).toEqual([cancelled])
  })

  it('preserves the blocker outcome and every existing delivery while making cancellation terminal', async () => {
    const settings = fixtureExecutionSettings('/tmp/fixture-target', '/tmp/fixture-worktrees')
    const { ctx } = await boot(await databasePath(), [candidate()], 20, settings)
    await ctx.admission.reconcile({ source: 'manual' })
    const implementing = await ctx.admission.claimNext(fixtureCompositionClaim())
    if (implementing === undefined) throw new Error('expected an implementing run')
    const blocked = await ctx.admission.settle(
      implementing.runId,
      { kind: 'blocked', summary: 'Human input is required.', evidence: ['Question remains unanswered.'] },
      { kind: 'known', tokens: 9 },
    )
    if (blocked.state !== 'blocked') throw new Error('expected a blocked run')

    const cancelled = await ctx.admission.cancelRun(blocked.runId, blockedRequestId)
    if (!('outcome' in cancelled) || !('execution' in cancelled)) {
      throw new Error('expected a blocked cancelled run')
    }

    expect(cancelled).toEqual({
      ...blocked,
      state: 'cancelled',
      cancellation: {
        requestId: blockedRequestId,
        cancelledAt: expect.any(String),
        from: 'blocked',
      },
    })
    expect(cancelled.outcome).toEqual(blocked.outcome)
    expect(cancelled.execution).toEqual(blocked.execution)
    expect(cancelled.deliveries).toEqual(blocked.deliveries)
    expect(ctx.admission.trackerSwitchBlocker('fixture')).toMatch(/unresolved delivery intents/)
    expect(ctx.admission.codeHostSwitchBlocker('fixture-code-host')).toBeUndefined()
    expect(ctx.admission.codeHostBindingSwitchBlocker('fixture-code-host')).toMatch(/durable run history/)
    await expect(ctx.admission.resumeRun(cancelled.runId)).rejects.toThrow(/not paused/)
  })
})
