import { describe, expect, it, vi } from 'vitest'
import { Reconciliation } from '../src/reconciliation.js'
import { createFixtureTrackerProvider } from '../src/testing.js'
import { TrackerProviderError } from '../src/tracker.js'
import { AutopilotWeb, AutopilotWebContributions } from '../src/web.js'
import { boot, candidate, databasePath, disposeTrackedContext } from './admission-fixtures.js'
import { fixtureCompositionClaim, fixtureExecutionSettings } from './dsh-fixtures.js'

describe('Autopilot Web Host contract', () => {
  it('projects a bounded external-provider run page with honest integration seams', async () => {
    const path = await databasePath()
    const issues = [
      candidate({ summary: 'A very long external provider issue title that remains available to the browser fixture' }),
      candidate({ issueId: 'issue-2' as never, displayKey: 'FIX-2', priorityRank: 7 }),
    ]
    const { ctx } = await boot(path, issues)
    await ctx.admission.reconcile({ source: 'manual' })
    await ctx.plugin(Reconciliation)
    await ctx.plugin(AutopilotWebContributions)
    await ctx.plugin(AutopilotWeb)

    const snapshot = ctx.autopilotWeb.operations({ offset: 0, limit: 1, search: 'external provider' })
    expect(snapshot.providers).toEqual([
      expect.objectContaining({
        id: 'fixture',
        displayName: 'Fixture tracker',
        selected: true,
        availability: 'available',
        configurationNamespace: 'fixture-tracker',
      }),
    ])
    expect(snapshot.runs.total).toBe(1)
    expect(snapshot.runs.items).toHaveLength(1)
    expect(snapshot.runs.items[0]).toMatchObject({
      lifecycle: 'queued',
      ticket: { status: 'unknown' },
      pullRequest: { status: 'unknown' },
      deliveries: [],
      actions: ['pause-run', 'cancel-run'],
    })
    expect(snapshot.integrations).toEqual({
      deliveries: { status: 'unavailable', reason: 'No delivery contribution is mounted.' },
      worktrees: {
        status: 'unavailable',
        reason: 'No worktree maintenance contribution is mounted; cleanup remains disabled.',
      },
    })

    const firstRun = snapshot.runs.items[0]
    expect(firstRun).toBeDefined()
    if (firstRun === undefined) throw new Error('expected one run')
    const run = ctx.autopilotWeb.run(firstRun.runId)
    expect(run).toMatchObject({
      brief: { content: expect.stringContaining('Agent Brief') as unknown },
      timeline: [{ label: 'Admitted to queue' }],
    })
    expect(ctx.autopilotWeb.run('missing')).toBeNull()
  })

  it('accepts one command id, finishes on the Host, and never replays it on status reads', async () => {
    const path = await databasePath()
    const { ctx } = await boot(path, [candidate()])
    await ctx.admission.reconcile({ source: 'manual' })
    await ctx.plugin(Reconciliation)
    await ctx.plugin(AutopilotWebContributions)
    await ctx.plugin(AutopilotWeb)
    const admitted = ctx.admission.snapshot().runs[0]
    expect(admitted).toBeDefined()
    if (admitted === undefined) throw new Error('expected one admitted run')
    const runId = admitted.runId
    const request = {
      requestId: '9ae195c9-afc7-4a9d-bfb3-ae63a9439878',
      kind: 'pause-run' as const,
      runId,
    }

    await expect(ctx.autopilotWeb.command(request)).resolves.toMatchObject({ status: 'accepted', kind: 'pause-run' })
    await vi.waitFor(() => {
      expect(ctx.autopilotWeb.commandStatus(request.requestId)).toMatchObject({ status: 'succeeded' })
    })
    expect(ctx.admission.snapshot().runs[0]).toMatchObject({ state: 'paused', pause: { operatorHold: true } })
    expect(ctx.autopilotWeb.operations({ offset: 0, limit: 50 }).runs.items[0]?.actions).toEqual([
      'resume-run',
      'cancel-run',
    ])
    await expect(ctx.autopilotWeb.command(request)).resolves.toMatchObject({ status: 'succeeded' })
    await expect(ctx.autopilotWeb.command({ ...request, kind: 'resume-run' })).rejects.toThrow(/different action/)
  })

  it('cancels a quiescent run with the command identity and projects its terminal history', async () => {
    const { ctx } = await boot(await databasePath(), [candidate()])
    await ctx.admission.reconcile({ source: 'manual' })
    await ctx.plugin(Reconciliation)
    await ctx.plugin(AutopilotWebContributions)
    await ctx.plugin(AutopilotWeb)
    const queued = ctx.admission.snapshot().runs[0]
    if (queued?.state !== 'queued') throw new Error('expected a queued run')
    const request = {
      requestId: '45bf915e-90eb-42b0-9299-388e45fc4054',
      kind: 'cancel-run' as const,
      runId: queued.runId,
    }

    await expect(ctx.autopilotWeb.command(request)).resolves.toMatchObject({ status: 'accepted' })
    await vi.waitFor(() => {
      expect(ctx.autopilotWeb.commandStatus(request.requestId)).toMatchObject({ status: 'succeeded' })
    })

    const cancelled = ctx.admission.snapshot().runs[0]
    expect(cancelled).toMatchObject({
      state: 'cancelled',
      cancellation: { requestId: request.requestId, from: 'queued' },
    })
    if (cancelled?.state !== 'cancelled') throw new Error('expected a cancelled run')
    expect(ctx.autopilotWeb.operations({ offset: 0, limit: 50, states: ['cancelled'] }).runs.items).toEqual([
      expect.objectContaining({
        runId: queued.runId,
        lifecycle: 'cancelled',
        reason: 'Cancelled by operator',
        updatedAt: cancelled.cancellation.cancelledAt,
        actions: [],
      }),
    ])
    expect(ctx.autopilotWeb.run(queued.runId)?.timeline).toEqual([
      { at: queued.queuedAt, label: 'Admitted to queue' },
      {
        at: cancelled.cancellation.cancelledAt,
        label: 'Run cancelled',
        detail: 'Operator ended this quiescent run; retained resources and delivery history were preserved.',
      },
    ])
  })

  it('rejects direct active cancellation and exposes it only after the run becomes blocked', async () => {
    const { ctx } = await boot(
      await databasePath(),
      [candidate()],
      20,
      fixtureExecutionSettings('/tmp/fixture-target', '/tmp/fixture-worktrees'),
    )
    await ctx.admission.reconcile({ source: 'manual' })
    const implementing = await ctx.admission.claimNext(fixtureCompositionClaim())
    if (implementing === undefined) throw new Error('expected an implementing run')
    await ctx.plugin(Reconciliation)
    await ctx.plugin(AutopilotWebContributions)
    await ctx.plugin(AutopilotWeb)
    const request = {
      requestId: 'f955ae56-fd82-47fe-ad5f-cd5bf6bb20de',
      kind: 'cancel-run' as const,
      runId: implementing.runId,
    }

    expect(ctx.autopilotWeb.operations({ offset: 0, limit: 50 }).runs.items[0]?.actions).not.toContain('cancel-run')
    await expect(ctx.autopilotWeb.command(request)).rejects.toThrow(/cannot be cancelled from implementing/)
    expect(ctx.admission.operatorCommand(request.requestId)).toBeUndefined()

    await ctx.admission.settle(
      implementing.runId,
      { kind: 'blocked', summary: 'A human decision is required.', evidence: ['No safe default exists.'] },
      { kind: 'known', tokens: 3 },
    )
    expect(ctx.autopilotWeb.operations({ offset: 0, limit: 50 }).runs.items[0]?.actions).toEqual(['cancel-run'])
  })

  it('reports scheduler pause success when the durable gate changes without a Dispatch service', async () => {
    const { ctx } = await boot(await databasePath(), [])
    await ctx.plugin(Reconciliation)
    await ctx.plugin(AutopilotWebContributions)
    await ctx.plugin(AutopilotWeb)
    const request = {
      requestId: '23f18f66-b6b8-408f-9c3f-4e5fdecb47df',
      kind: 'pause-scheduler' as const,
    }

    await expect(ctx.autopilotWeb.command(request)).resolves.toMatchObject({ status: 'accepted' })
    await vi.waitFor(() => {
      expect(ctx.autopilotWeb.commandStatus(request.requestId)).toMatchObject({ status: 'succeeded' })
    })
    expect(ctx.admission.snapshot().scheduler.mode).toBe('disabled')
  })

  it('recovers a durably accepted command after a Host restart without replaying a new identity', async () => {
    const path = await databasePath()
    const first = await boot(path, [candidate()])
    await first.ctx.admission.reconcile({ source: 'manual' })
    const run = first.ctx.admission.snapshot().runs[0]
    if (run === undefined) throw new Error('expected one admitted run')
    const request = {
      requestId: '2998f559-a53f-4ddf-9e18-d0ab806307c1',
      kind: 'pause-run' as const,
      runId: run.runId,
    }
    await first.ctx.admission.acceptOperatorCommand(request)
    await disposeTrackedContext(first.ctx)

    const second = await boot(path, [])
    await second.ctx.plugin(Reconciliation)
    await second.ctx.plugin(AutopilotWebContributions)
    await second.ctx.plugin(AutopilotWeb)
    await vi.waitFor(() => {
      expect(second.ctx.autopilotWeb.commandStatus(request.requestId)).toMatchObject({ status: 'succeeded' })
    })
    expect(second.ctx.admission.snapshot().runs[0]).toMatchObject({ state: 'paused' })
    await expect(second.ctx.autopilotWeb.command(request)).resolves.toMatchObject({ status: 'succeeded' })
  })

  it('rejects a tracker switch while a durable run depends on the current provider', async () => {
    const { ctx } = await boot(await databasePath(), [candidate()])
    await ctx.admission.reconcile({ source: 'manual' })

    await expect(ctx.settings.update('dsh-autopilot', { trackerProvider: 'replacement' })).rejects.toThrow(
      /cannot change.*unfinished work/i,
    )
    expect(ctx.autopilotConfig.get().trackerProvider).toBe('fixture')
  })

  it('does not redirect admitted work through later code-host or repository Settings changes', async () => {
    const { ctx } = await boot(await databasePath(), [candidate()])
    await ctx.admission.reconcile({ source: 'manual' })

    await expect(ctx.settings.update('dsh-autopilot', { codeHostProvider: 'replacement' })).rejects.toThrow(
      /code-host configuration cannot change/i,
    )
    await expect(ctx.settings.update('dsh-autopilot', { targetRepository: '/tmp/replacement' })).rejects.toThrow(
      /execution routing cannot change/i,
    )
    expect(ctx.autopilotConfig.get()).toMatchObject({ codeHostProvider: 'fixture-code-host', targetRepository: '' })
  })

  it('allows a headless tracker switch when durable admission state has no dependents', async () => {
    const { ctx } = await boot(await databasePath(), [])

    await expect(ctx.settings.update('dsh-autopilot', { trackerProvider: 'replacement' })).resolves.toBeUndefined()
    expect(ctx.autopilotConfig.get().trackerProvider).toBe('replacement')
  })

  it('tests provider readiness without returning candidate content', async () => {
    const path = await databasePath()
    const { ctx } = await boot(path, [candidate({ summary: 'secret fixture title' })])
    await ctx.plugin(Reconciliation)
    await ctx.plugin(AutopilotWebContributions)
    await ctx.plugin(AutopilotWeb)

    await expect(ctx.autopilotWeb.testProvider('fixture', new AbortController().signal)).resolves.toEqual({
      providerId: 'fixture',
      checkedAt: expect.any(String),
      status: 'ready',
    })
  })

  it('redacts provider-authored details from readiness checks and durable command failures', async () => {
    const sentinel = 'secret upstream ticket and token'
    const { ctx, disposeProvider } = await boot(await databasePath(), [])
    await disposeProvider()
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues: [],
        readCandidates: () => Promise.reject(new TrackerProviderError('transient', sentinel)),
      }),
    )
    await ctx.plugin(Reconciliation)
    await ctx.plugin(AutopilotWebContributions)
    await ctx.plugin(AutopilotWeb)

    const providerResult = await ctx.autopilotWeb.testProvider('fixture', new AbortController().signal)
    expect(providerResult).toMatchObject({
      status: 'failed',
      reason: 'transient: The tracker was temporarily unavailable.',
    })
    const requestId = '44624d0e-b08d-4cfc-ad03-97d08e46af3e'
    await ctx.autopilotWeb.command({ requestId, kind: 'reconcile' })
    await vi.waitFor(() => {
      expect(ctx.autopilotWeb.commandStatus(requestId)).toMatchObject({
        status: 'rejected',
        message: 'transient: The tracker was temporarily unavailable.',
      })
    })
    expect(JSON.stringify({ providerResult, commands: ctx.admission.operatorCommands() })).not.toContain(sentinel)
  })
})
