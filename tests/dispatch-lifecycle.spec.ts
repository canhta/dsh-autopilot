import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bootFixture, ControlledAdapter, temporaryDirectories } from './dispatch-fixtures.js'
import { Deferred, executionAgentRegistryFiber, remountExecutionAgentRegistry } from './dsh-fixtures.js'

describe('durable fixture dispatch: lifecycle and pause', () => {
  it('keeps scheduler-disabled work pausing until the cancellation-resistant root is quiescent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-dispatch-pause-'))
    temporaryDirectories.push(root)
    const requestStarted = new Deferred<void>()
    const releaseRequest = new Deferred<void>()
    const ctx = await bootFixture(
      root,
      new ControlledAdapter('verified', 'known', 'valid', async () => {
        requestStarted.resolve()
        await releaseRequest.promise
      }),
    )
    const dispatched = ctx.dispatch.dispatchNext()
    await requestStarted.promise

    const disabled = ctx.dispatch.disableScheduler()
    await expect.poll(() => ctx.admission.snapshot().runs[0]?.state).toBe('pausing')
    expect(ctx.admission.snapshot()).toMatchObject({
      scheduler: { mode: 'disabled' },
      runs: [
        {
          state: 'pausing',
          pause: { reason: 'scheduler', operatorHold: false, continuationTarget: 'implementing' },
          budget: { reservedTokens: 60 },
        },
      ],
      budget: { reservedTokens: 60 },
    })
    expect(ctx.agents.roots()).toHaveLength(1)

    releaseRequest.resolve()
    const [disabledSnapshot, paused] = await Promise.all([disabled, dispatched])

    expect(disabledSnapshot).toMatchObject({ scheduler: { mode: 'disabled' }, runs: [{ state: 'paused' }] })
    expect(paused).toMatchObject({
      state: 'paused',
      pause: {
        reason: 'scheduler',
        operatorHold: false,
        continuationTarget: 'implementing',
        lastCompletedPhase: 'agent-quiescent',
      },
      execution: { git: { head: expect.stringMatching(/^[a-f0-9]{40}$/) } },
      budget: {
        reservedTokens: 60,
        settledTokens: 0,
        usageUncertain: true,
        usageUncertaintyReason: expect.stringMatching(/usage record/),
      },
    })
    if (paused === undefined || paused.state !== 'paused' || paused.pause.kind !== 'active') {
      throw new Error('expected an allocated pause checkpoint')
    }
    await expect(ctx.sessionPersistence.stat(paused.execution.sessionId)).resolves.toMatchObject({
      header: { id: paused.execution.sessionId },
    })
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: paused.execution.worktreePath, encoding: 'utf8' }),
    ).toBe(paused.execution.git?.status)
    expect(ctx.agents.roots()).toEqual([])
  })

  it('persists an operator hold only after an active root reaches its checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-dispatch-stop-'))
    temporaryDirectories.push(root)
    const requestStarted = new Deferred<void>()
    const releaseRequest = new Deferred<void>()
    const ctx = await bootFixture(
      root,
      new ControlledAdapter('verified', 'known', 'valid', async () => {
        requestStarted.resolve()
        await releaseRequest.promise
      }),
    )
    const dispatched = ctx.dispatch.dispatchNext()
    await requestStarted.promise
    const run = ctx.admission.snapshot().runs[0]
    if (run?.state !== 'implementing') throw new Error('expected active fixture run')

    const stopped = ctx.dispatch.stopRun(run.runId)
    await expect.poll(() => ctx.admission.snapshot().runs[0]?.state).toBe('pausing')
    expect(ctx.admission.snapshot()).toMatchObject({
      scheduler: { mode: 'enabled' },
      runs: [{ pause: { reason: 'operator', operatorHold: true } }],
    })

    releaseRequest.resolve()
    const [stoppedRun, paused] = await Promise.all([stopped, dispatched])
    expect(stoppedRun).toEqual(paused)
    expect(paused).toMatchObject({ state: 'paused', pause: { reason: 'operator', operatorHold: true } })
  })

  it('checkpoints active work before required-service withdrawal and preserves uncertainty across remount', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-dispatch-service-remount-'))
    temporaryDirectories.push(root)
    const requestStarted = new Deferred<void>()
    const releaseRequest = new Deferred<void>()
    const adapter = new ControlledAdapter('verified', 'known', 'valid', async () => {
      requestStarted.resolve()
      await releaseRequest.promise
    })
    const ctx = await bootFixture(root, adapter)
    const retiringDispatch = ctx.dispatch
    const dispatched = retiringDispatch.dispatchNext()
    await requestStarted.promise

    const withdrawing = executionAgentRegistryFiber(ctx).dispose()
    await expect.poll(() => ctx.admission.snapshot().runs[0]?.state).toBe('pausing')
    expect(ctx.admission.snapshot()).toMatchObject({
      scheduler: { mode: 'enabled' },
      runs: [{ state: 'pausing', pause: { reason: 'service-withdrawal', operatorHold: false } }],
    })

    releaseRequest.resolve()
    const paused = await dispatched
    await withdrawing

    expect(paused).toMatchObject({
      state: 'paused',
      pause: { reason: 'service-withdrawal', operatorHold: false, lastCompletedPhase: 'agent-quiescent' },
    })
    if (paused === undefined || paused.state !== 'paused' || paused.pause.kind !== 'active') {
      throw new Error('required-service withdrawal did not produce an allocated pause')
    }
    expect(ctx.get('dispatch')).toBeUndefined()
    expect(ctx.get('agents')).toBeUndefined()
    await expect(retiringDispatch.dispatchNext()).rejects.toThrow(/unavailable.*services are changing/i)

    await remountExecutionAgentRegistry(ctx)
    await expect.poll(() => ctx.get('dispatch')).toBeDefined()
    await expect(ctx.dispatch.dispatchNext()).rejects.toThrow(/token usage is uncertain/)

    expect(ctx.admission.snapshot().runs).toHaveLength(1)
    expect(ctx.admission.snapshot().runs[0]).toMatchObject({
      runId: paused.runId,
      state: 'paused',
      budget: { usageUncertain: true },
    })
    expect(ctx.agents.roots()).toEqual([])
  })

  it('does not strand a claimed run when service withdrawal overlaps Agent creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-dispatch-service-setup-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter())
    const createStarted = new Deferred<void>()
    const releaseCreate = new Deferred<void>()
    const createAgent = ctx.agents.create.bind(ctx.agents)
    ctx.agents.create = async (options) => {
      createStarted.resolve()
      await releaseCreate.promise
      return await createAgent(options)
    }
    const dispatching = ctx.dispatch.dispatchNext()
    await createStarted.promise

    const withdrawing = executionAgentRegistryFiber(ctx).dispose()
    await expect.poll(() => ctx.get('dispatch')).toBeUndefined()
    expect(ctx.admission.snapshot().runs[0]).toMatchObject({ state: 'implementing' })

    releaseCreate.resolve()
    const settled = await Promise.allSettled([dispatching, withdrawing])

    const run = ctx.admission.snapshot().runs[0]
    expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(run?.state).not.toBe('pausing')
    expect(ctx.get('agents')).toBeUndefined()
  })

  it('fences late settlement and resumes the same run after the execution service remounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-dispatch-late-remount-'))
    temporaryDirectories.push(root)
    const adapter = new ControlledAdapter('verified', 'known', 'valid', undefined, true)
    const ctx = await bootFixture(root, adapter)
    const recordWorktree = ctx.admission.recordWorktree.bind(ctx.admission)
    let recordCount = 0
    let withdrawing: Promise<void> | undefined
    ctx.admission.recordWorktree = async (runId, git) => {
      const recorded = await recordWorktree(runId, git)
      recordCount += 1
      if (recordCount === 2) {
        withdrawing = executionAgentRegistryFiber(ctx).dispose()
        await expect.poll(() => ctx.admission.snapshot().runs[0]?.state).toBe('pausing')
      }
      return recorded
    }

    const paused = await ctx.dispatch.dispatchNext()
    await withdrawing

    expect(paused).toMatchObject({
      state: 'paused',
      pause: { reason: 'service-withdrawal', operatorHold: false },
      budget: { reservedTokens: 0, settledTokens: 18, usageUncertain: false },
    })
    if (paused === undefined || paused.state !== 'paused') throw new Error('expected a late-settlement pause')
    expect(ctx.get('dispatch')).toBeUndefined()

    await remountExecutionAgentRegistry(ctx)
    await expect.poll(() => ctx.get('dispatch')).toBeDefined()
    const completed = await ctx.dispatch.dispatchNext()

    expect(completed).toMatchObject({
      runId: paused.runId,
      state: 'publishing',
      execution: { attempt: 2, sessionId: paused.execution.sessionId },
      budget: { settledTokens: 36, usageUncertain: false },
    })
    expect(ctx.admission.snapshot().runs).toHaveLength(1)
    expect(ctx.agents.roots()).toEqual([])
  })

  it('lets a pause checkpoint win a race with terminal settlement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-dispatch-settle-race-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter())
    const recordWorktree = ctx.admission.recordWorktree.bind(ctx.admission)
    let recordCount = 0
    let disabling: Promise<unknown> | undefined
    ctx.admission.recordWorktree = async (runId, git) => {
      const recorded = await recordWorktree(runId, git)
      recordCount += 1
      if (recordCount === 2) {
        disabling = ctx.dispatch.disableScheduler()
        await expect.poll(() => ctx.admission.snapshot().runs[0]?.state).toBe('pausing')
      }
      return recorded
    }

    const paused = await ctx.dispatch.dispatchNext()
    await disabling

    expect(paused).toMatchObject({
      state: 'paused',
      pause: { reason: 'scheduler', lastCompletedPhase: 'agent-quiescent' },
      budget: { reservedTokens: 0, settledTokens: 18, usageUncertain: false },
    })
    expect(ctx.admission.snapshot()).toMatchObject({
      scheduler: { mode: 'disabled' },
      runs: [{ state: 'paused' }],
      budget: { reservedTokens: 0, settledTokens: 18, usageUncertain: false },
    })
  })
})
