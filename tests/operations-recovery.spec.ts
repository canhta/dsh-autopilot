import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bootFixture, ControlledAdapter, candidate, temporaryDirectories } from './dispatch-fixtures.js'
import { Deferred } from './dsh-fixtures.js'

describe('operations recovery readiness', () => {
  it('reports a newly registered required contributor as pending until its first valid reconciliation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-unverified-recovery-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter())

    expect(ctx.autopilotOperations.health()).toMatchObject({
      recovery: { status: 'required', participants: { 'publication-delivery': { pending: 1 } } },
      admission: { status: 'blocked' },
    })

    await expect(ctx.autopilotOperations.assertDispatchReady()).resolves.toBeUndefined()
    expect(ctx.autopilotOperations.health()).toMatchObject({
      recovery: { status: 'complete', participants: { 'publication-delivery': { pending: 0 } } },
      admission: { status: 'permitted' },
    })
  })

  it('fences dispatch until a registered publication/delivery recovery participant is clear', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-delivery-recovery-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter())
    let pending = 1
    ctx.autopilotOperations.registerRecoveryParticipant('publication', {
      reconcile: () => Promise.resolve({ pending }),
    })

    await expect(ctx.dispatch.dispatchNext()).rejects.toThrow(/recovery.*before execution/i)
    expect(ctx.admission.snapshot().runs[0]).toMatchObject({ state: 'queued' })

    pending = 0
    await expect(ctx.dispatch.dispatchNext()).resolves.toMatchObject({ state: 'publishing' })
  })

  it('fails closed when the required publication/delivery recovery contributor is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-required-recovery-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter(), [candidate()], {}, { withExecutionLifecycle: false })

    await expect(ctx.autopilotOperations.assertDispatchReady()).rejects.toThrow(/required recovery participant/i)
    expect(ctx.admission.snapshot().runs[0]).toMatchObject({ state: 'queued' })
  })

  it('fails closed when a recovery contributor returns malformed facts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-malformed-recovery-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter())
    ctx.autopilotOperations.registerRecoveryParticipant('malformed-recovery', {
      reconcile: () => Promise.resolve({ pending: -1 }),
    })

    await expect(ctx.dispatch.dispatchNext()).rejects.toThrow(/recovery.*before execution/i)
    expect(ctx.autopilotOperations.health().recovery).toMatchObject({
      status: 'failed',
      participants: { 'malformed-recovery': { pending: 1, failure: expect.stringMatching(/invalid pending/i) } },
    })
  })

  it('withdraws a generation by cancelling and draining active reconciliation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-recovery-withdrawal-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter())
    const late = new Deferred<{ pending: number }>()
    let observedSignal: AbortSignal | undefined
    const dispose = ctx.autopilotOperations.registerRecoveryParticipant('late-recovery', {
      reconcile: (signal) => {
        observedSignal = signal
        return late.promise
      },
    })
    const readiness = ctx.autopilotOperations.assertDispatchReady()

    await expect.poll(() => observedSignal).toBeDefined()
    const retiring = dispose()
    expect(observedSignal?.aborted).toBe(true)
    expect(() =>
      ctx.autopilotOperations.registerRecoveryParticipant('late-recovery', {
        reconcile: () => Promise.resolve({ pending: 0 }),
      }),
    ).toThrow(/already registered/i)
    late.resolve({ pending: 0 })

    await expect(readiness).rejects.toThrow(/withdrawn|changed during reconciliation/i)
    await expect(retiring).resolves.toBeUndefined()
    let replacementCalls = 0
    ctx.autopilotOperations.registerRecoveryParticipant('late-recovery', {
      reconcile: () => {
        replacementCalls += 1
        return Promise.resolve({ pending: 0 })
      },
    })
    await expect(ctx.autopilotOperations.assertDispatchReady()).resolves.toBeUndefined()
    expect(replacementCalls).toBe(1)
  })

  it('reports an intentional scheduler pause separately from process and persistence health', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-health-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter())
    await ctx.dispatch.dispatchNext()
    await ctx.admission.setSchedulerMode('disabled')

    expect(ctx.autopilotOperations.health()).toMatchObject({
      process: { status: 'alive', owner: { status: 'held' } },
      persistence: { status: 'ready' },
      recovery: { status: 'complete' },
      integrations: { codeHost: { status: 'available' } },
      admission: { status: 'paused', mode: 'disabled' },
    })
  })
})
