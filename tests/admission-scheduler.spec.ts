import { describe, expect, it } from 'vitest'
import {
  boot,
  candidate,
  databasePath,
  disposeTrackedContext,
  fixtureProvider,
  rejectAdmissionUpdates,
} from './admission-fixtures.js'
import { fixtureExecutionSettings } from './dsh-fixtures.js'

describe('admission scheduler and allocated pauses', () => {
  it('persists scheduler stops across restarts without reading or changing admission state', async () => {
    const path = await databasePath()
    const executionSettings = fixtureExecutionSettings('/tmp/fixture-target', '/tmp/fixture-worktrees')
    let providerReads = 0
    const countRead = () => {
      providerReads += 1
    }
    const first = await boot(path, [candidate()], 20, executionSettings, countRead)
    await first.ctx.admission.reconcile({ source: 'manual' })
    expect(providerReads).toBe(1)

    const draining = await first.ctx.admission.setSchedulerMode('draining')
    expect(draining).toMatchObject({
      scheduler: { mode: 'draining' },
      runs: [{ state: 'queued' }],
    })
    expect(Date.parse(draining.scheduler.changedAt)).not.toBeNaN()
    const drainingChangedAt = draining.scheduler.changedAt
    ;(draining.scheduler as { mode: string }).mode = 'enabled'
    const exposedRun = draining.runs[0]
    if (exposedRun === undefined) throw new Error('expected a queued run')
    ;(exposedRun as { summary: string }).summary = 'caller mutation'
    expect(first.ctx.admission.snapshot()).toMatchObject({
      scheduler: { mode: 'draining', changedAt: drainingChangedAt },
      runs: [{ summary: 'Implement durable tracker admission', state: 'queued' }],
    })

    const beforeDrainingReconcile = first.ctx.admission.snapshot()
    const drainingReconcile = await first.ctx.admission.reconcile({
      source: 'webhook',
      deliveryId: 'fixture:draining-delivery',
    })
    expect(drainingReconcile).toEqual({ ...beforeDrainingReconcile, decisions: [] })
    expect(providerReads).toBe(1)
    expect(drainingReconcile.acceptedIngress).not.toContain('fixture:draining-delivery')
    await expect(first.ctx.admission.claimNext()).resolves.toBeUndefined()
    await disposeTrackedContext(first.ctx)

    const second = await boot(path, [candidate()], 20, executionSettings, countRead)
    expect(second.ctx.admission.snapshot().scheduler).toEqual({
      mode: 'draining',
      changedAt: drainingChangedAt,
    })
    const disabled = await second.ctx.admission.setSchedulerMode('disabled')
    expect(disabled.scheduler).toMatchObject({
      mode: 'disabled',
    })
    expect(Date.parse(disabled.scheduler.changedAt)).not.toBeNaN()
    const disabledChangedAt = disabled.scheduler.changedAt
    await disposeTrackedContext(second.ctx)

    const third = await boot(path, [candidate()], 20, executionSettings, countRead)
    const beforeDisabledReconcile = third.ctx.admission.snapshot()
    expect(beforeDisabledReconcile.scheduler).toEqual({ mode: 'disabled', changedAt: disabledChangedAt })
    const disabledReconcile = await third.ctx.admission.reconcile({ source: 'scheduled' })
    expect(disabledReconcile).toEqual({ ...beforeDisabledReconcile, decisions: [] })
    expect(providerReads).toBe(1)
    await expect(third.ctx.admission.claimNext()).resolves.toBeUndefined()
  })

  it('rejects disable atomically while implementing but permits draining settlement', async () => {
    const { ctx } = await boot(
      await databasePath(),
      [candidate()],
      20,
      fixtureExecutionSettings('/tmp/fixture-target', '/tmp/fixture-worktrees'),
    )
    await ctx.admission.reconcile({ source: 'manual' })
    const claimed = await ctx.admission.claimNext()
    if (claimed === undefined) throw new Error('expected an implementing run')
    const beforeDisable = ctx.admission.snapshot()

    await expect(ctx.admission.setSchedulerMode('disabled')).rejects.toThrow(/implementing run/i)
    expect(ctx.admission.snapshot()).toEqual(beforeDisable)

    await expect(ctx.admission.setSchedulerMode('draining')).resolves.toMatchObject({
      scheduler: { mode: 'draining' },
      runs: [{ state: 'implementing' }],
    })
    const settled = await ctx.admission.settle(
      claimed.runId,
      { kind: 'failed', summary: 'Fixture drain settlement.', evidence: ['fixture'] },
      { kind: 'known', tokens: 10 },
    )
    expect(settled).toMatchObject({ state: 'failed', budget: { reservedTokens: 0, settledTokens: 10 } })
    expect(ctx.admission.snapshot()).toMatchObject({
      scheduler: { mode: 'draining' },
      runs: [{ state: 'failed' }],
      budget: { reservedTokens: 0, settledTokens: 10, usageUncertain: false },
    })
    await expect(ctx.admission.claimNext()).resolves.toBeUndefined()
  })

  it('persists an allocated pause checkpoint and keeps scheduler enablement blocked until quiescence', async () => {
    const path = await databasePath()
    const executionSettings = fixtureExecutionSettings('/tmp/fixture-target', '/tmp/fixture-worktrees')
    const first = await boot(path, [candidate()], 20, executionSettings)
    await first.ctx.admission.reconcile({ source: 'manual' })
    const claimed = await first.ctx.admission.claimNext()
    if (claimed === undefined) throw new Error('expected an implementing run')

    const requested = await first.ctx.admission.requestSchedulerDisable()
    expect(requested).toMatchObject({
      snapshot: {
        scheduler: { mode: 'disabled' },
        runs: [
          {
            runId: claimed.runId,
            state: 'pausing',
            pause: {
              kind: 'active',
              reason: 'scheduler',
              operatorHold: false,
              continuationTarget: 'implementing',
              interruptedOperation: 'agent-turn',
            },
            budget: { reservedTokens: 60 },
          },
        ],
      },
      pausingRunIds: [claimed.runId],
    })
    await expect(first.ctx.admission.setSchedulerMode('enabled')).rejects.toThrow(/still pausing/)

    const git = { baseHead: 'a'.repeat(40), head: 'b'.repeat(40), status: ' M retained.txt\n' }
    const paused = await first.ctx.admission.checkpointPaused(claimed.runId, git, { kind: 'known', tokens: 12 })
    expect(paused).toMatchObject({
      runId: claimed.runId,
      state: 'paused',
      execution: { sessionId: claimed.execution.sessionId, worktreePath: claimed.execution.worktreePath, git },
      pause: {
        kind: 'active',
        reason: 'scheduler',
        operatorHold: false,
        pausedAt: expect.any(String),
        lastCompletedPhase: 'agent-quiescent',
      },
      budget: { reservedTokens: 0, settledTokens: 12, usageUncertain: false },
    })
    expect(first.ctx.admission.snapshot().budget).toEqual({
      reservedTokens: 0,
      settledTokens: 12,
      usageUncertain: false,
    })
    await disposeTrackedContext(first.ctx)

    const second = await boot(path, [], 20, executionSettings)
    expect(second.ctx.admission.snapshot()).toMatchObject({
      scheduler: { mode: 'disabled' },
      runs: [paused],
      budget: { reservedTokens: 0, settledTokens: 12, usageUncertain: false },
    })
    const held = await second.ctx.admission.requestRunPause(claimed.runId)
    expect(held).toMatchObject({ state: 'paused', pause: { reason: 'operator', operatorHold: true } })
  })

  it('keeps a pausing run and its reservation when checkpoint persistence fails', async () => {
    const path = await databasePath()
    const { ctx } = await boot(
      path,
      [candidate()],
      20,
      fixtureExecutionSettings('/tmp/fixture-target', '/tmp/fixture-worktrees'),
    )
    await ctx.admission.reconcile({ source: 'manual' })
    const claimed = await ctx.admission.claimNext()
    if (claimed === undefined) throw new Error('expected an implementing run')
    await ctx.admission.requestSchedulerDisable()
    const before = ctx.admission.snapshot()
    rejectAdmissionUpdates(path)

    await expect(
      ctx.admission.checkpointPaused(
        claimed.runId,
        { baseHead: 'a'.repeat(40), head: 'b'.repeat(40), status: '' },
        { kind: 'known', tokens: 12 },
      ),
    ).rejects.toThrow(/forced durable failure/)

    expect(ctx.admission.snapshot()).toEqual(before)
    expect(before).toMatchObject({
      scheduler: { mode: 'disabled' },
      runs: [{ state: 'pausing', budget: { reservedTokens: 60 } }],
      budget: { reservedTokens: 60, usageUncertain: false },
    })
  })

  it('validates and persists an allocated-pause recovery requirement across restart', async () => {
    const path = await databasePath()
    const executionSettings = fixtureExecutionSettings('/tmp/fixture-target', '/tmp/fixture-worktrees')
    const first = await boot(path, [candidate()], 20, executionSettings)
    await first.ctx.admission.reconcile({ source: 'manual' })
    const claimed = await first.ctx.admission.claimNext()
    if (claimed === undefined) throw new Error('expected an implementing run')
    await first.ctx.admission.requestSchedulerDisable()
    const git = { baseHead: 'a'.repeat(40), head: 'b'.repeat(40), status: '' }
    const paused = await first.ctx.admission.checkpointPaused(claimed.runId, git, { kind: 'known', tokens: 12 })
    const before = first.ctx.admission.snapshot()

    await expect(first.ctx.admission.requireActiveRecovery(paused.runId, 'host-restart' as never)).rejects.toThrow(
      /session-unavailable|workspace-unavailable|worktree-mismatch/,
    )
    expect(first.ctx.admission.snapshot()).toEqual(before)

    const recovery = await first.ctx.admission.requireActiveRecovery(paused.runId, 'worktree-mismatch')
    expect(recovery).toMatchObject({
      state: 'paused',
      execution: { recovery: { kind: 'required', reason: 'worktree-mismatch', interruptedAt: expect.any(String) } },
      budget: { reservedTokens: 0, settledTokens: 12 },
    })
    expect(await first.ctx.admission.requireActiveRecovery(paused.runId, 'worktree-mismatch')).toEqual(recovery)
    await disposeTrackedContext(first.ctx)

    const second = await boot(path, [candidate()], 20, executionSettings)
    expect(second.ctx.admission.snapshot().runs[0]).toEqual(recovery)
    await second.ctx.admission.setSchedulerMode('enabled')
    await expect(second.ctx.admission.resumeActiveRun(paused.runId, git, 'operator')).rejects.toThrow(
      /explicit recovery/,
    )
  })

  it('retains the original attempt allowance while accumulating same-run continuation usage', async () => {
    const { ctx } = await boot(
      await databasePath(),
      [candidate()],
      20,
      fixtureExecutionSettings('/tmp/fixture-target', '/tmp/fixture-worktrees', {
        deploymentTokenCap: 100,
        perRunTokenCap: 80,
        runTokenAllowance: 20,
      }),
    )
    await ctx.admission.reconcile({ source: 'manual' })
    const claimed = await ctx.admission.claimNext()
    if (claimed === undefined) throw new Error('expected an implementing run')
    expect(claimed.budget).toMatchObject({ capTokens: 80, allowanceTokens: 20, reservedTokens: 20 })
    await ctx.admission.requestSchedulerDisable()
    const git = { baseHead: 'a'.repeat(40), head: 'b'.repeat(40), status: '' }
    await ctx.admission.checkpointPaused(claimed.runId, git, { kind: 'known', tokens: 12 })
    await ctx.admission.setSchedulerMode('enabled')

    const resumed = await ctx.admission.resumeActiveRun(claimed.runId, git, 'scheduler')

    expect(resumed).toMatchObject({
      state: 'implementing',
      execution: { attempt: 2 },
      budget: { capTokens: 80, allowanceTokens: 20, reservedTokens: 20, settledTokens: 12 },
    })
    const settled = await ctx.admission.settle(
      claimed.runId,
      { kind: 'failed', summary: 'Controlled continuation result.', evidence: ['fixture'] },
      { kind: 'known', tokens: 8 },
    )
    expect(settled.budget).toMatchObject({ allowanceTokens: 20, reservedTokens: 0, settledTokens: 20 })
    expect(ctx.admission.snapshot().budget).toEqual({
      reservedTokens: 0,
      settledTokens: 20,
      usageUncertain: false,
    })
  })

  it('leaves an active pause unchanged when tracker authorization is no longer current', async () => {
    const { ctx, disposeProvider } = await boot(
      await databasePath(),
      [candidate()],
      20,
      fixtureExecutionSettings('/tmp/fixture-target', '/tmp/fixture-worktrees'),
    )
    await ctx.admission.reconcile({ source: 'manual' })
    const claimed = await ctx.admission.claimNext()
    if (claimed === undefined) throw new Error('expected an implementing run')
    await ctx.admission.requestSchedulerDisable()
    const git = { baseHead: 'a'.repeat(40), head: 'b'.repeat(40), status: '' }
    await ctx.admission.checkpointPaused(claimed.runId, git, { kind: 'known', tokens: 12 })
    await ctx.admission.setSchedulerMode('enabled')
    await disposeProvider()
    ctx.tracker.register(fixtureProvider([candidate({ isReady: false })]))
    const before = ctx.admission.snapshot()

    await expect(ctx.admission.resumeActiveRun(claimed.runId, git, 'operator')).rejects.toThrow(
      /tracker authorization changed/i,
    )

    expect(ctx.admission.snapshot()).toEqual(before)
  })
})
