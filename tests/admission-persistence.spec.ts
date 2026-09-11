import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Admission } from '../src/admission.js'
import { AutopilotConfig } from '../src/config.js'
import { Tracker, trackerIssueId } from '../src/tracker.js'
import {
  boot,
  briefComment,
  candidate,
  databasePath,
  deterministicRunId,
  disposeTrackedContext,
  rejectAdmissionUpdates,
  rewriteStoredState,
  type StoredAdmissionState,
  trackContext,
  useDatabase,
  validBrief,
} from './admission-fixtures.js'
import { fixtureExecutionSettings, mountHostServices } from './dsh-fixtures.js'

describe('admission persistence and durable failures', () => {
  it('reopens with the same run identity and queue order', async () => {
    const path = await databasePath()
    const first = await boot(path, [
      candidate({ issueId: trackerIssueId('second'), displayKey: 'FIX-2', priorityRank: 2 }),
      candidate({ issueId: trackerIssueId('first'), displayKey: 'FIX-1', priorityRank: 1 }),
    ])
    await first.ctx.admission.reconcile({ source: 'startup' })
    const before = first.ctx.admission.snapshot()
    await disposeTrackedContext(first.ctx)

    const second = await boot(path, [])
    const after = second.ctx.admission.snapshot()

    expect(after).toEqual(before)
  })

  it('returns snapshots detached from authoritative in-memory state', async () => {
    const { ctx } = await boot(await databasePath(), [candidate()])
    await ctx.admission.reconcile({ source: 'manual' })
    const exposed = ctx.admission.snapshot()
    const run = exposed.runs[0]
    if (run === undefined) throw new Error('expected a queued run')

    ;(run as { summary: string }).summary = 'caller mutation'
    ;(run.brief as { content: string }).content = 'caller mutation'

    expect(ctx.admission.snapshot().runs[0]).toMatchObject({
      summary: 'Implement durable tracker admission',
      brief: { content: validBrief },
    })
  })

  it('rejects a provider backlog beyond the complete admission bound', async () => {
    const oversized = candidate({
      comments: [briefComment({ body: 'x'.repeat(17 * 1024 * 1024) })],
    })
    const { ctx } = await boot(await databasePath(), [oversized])
    const before = ctx.admission.snapshot()

    await expect(ctx.admission.reconcile({ source: 'manual' })).rejects.toMatchObject({
      code: 'invalid-response',
    })
    expect(ctx.admission.snapshot()).toEqual(before)
    expect(ctx.admission.snapshot()).toMatchObject({
      revision: 0,
      runs: [],
      acceptedIngress: [],
      budget: { reservedTokens: 0, settledTokens: 0, usageUncertain: false },
    })
  })

  it('fails explicitly when the durable admission record is corrupt on reopen', async () => {
    const path = await databasePath()
    const first = await boot(path, [candidate()])
    await first.ctx.admission.reconcile({ source: 'startup' })
    await disposeTrackedContext(first.ctx)
    useDatabase(path, (database) => {
      database
        .prepare('UPDATE u_autopilot_admission_state SET value = ? WHERE key = ?')
        .run(JSON.stringify({ schemaVersion: 1, runs: [{ state: 'queued' }] }), 'primary')
    })

    const ctx = trackContext(
      await mountHostServices(path, {
        'dsh-autopilot': { trackerProvider: 'fixture', maxQueued: 20 },
      }),
    )
    await ctx.plugin(Tracker)
    await ctx.plugin(AutopilotConfig)

    await expect(ctx.plugin(Admission)).rejects.toThrow(/stored record.*does not match its schema/i)
    await disposeTrackedContext(ctx)
  })

  it('fails closed when a version-5 durable admission record is reopened', async () => {
    const path = await databasePath()
    const first = await boot(path, [candidate()])
    await first.ctx.admission.reconcile({ source: 'startup' })
    await disposeTrackedContext(first.ctx)
    rewriteStoredState(path, (state) => {
      state.schemaVersion = 5
    })

    const ctx = trackContext(
      await mountHostServices(path, {
        'dsh-autopilot': { trackerProvider: 'fixture', maxQueued: 20 },
      }),
    )
    await ctx.plugin(Tracker)
    await ctx.plugin(AutopilotConfig)

    await expect(ctx.plugin(Admission)).rejects.toThrow(/stored record.*does not match its schema/i)
    await disposeTrackedContext(ctx)
  })

  it.each([
    {
      name: 'opaque binding id',
      mutate(state: StoredAdmissionState) {
        const run = state.runs[0]
        if (run === undefined) throw new Error('expected a stored run')
        run.bindingId = ''
        run.runId = deterministicRunId(run)
      },
    },
    {
      name: 'Brief byte bound',
      mutate(state: StoredAdmissionState) {
        const run = state.runs[0]
        if (run === undefined) throw new Error('expected a stored run')
        run.brief.content = 'x'.repeat(33 * 1024)
        run.brief.digest = createHash('sha256').update(run.brief.content).digest('hex')
      },
    },
    {
      name: 'summary byte bound',
      mutate(state: StoredAdmissionState) {
        const run = state.runs[0]
        if (run === undefined) throw new Error('expected a stored run')
        run.summary = 'x'.repeat(2049)
      },
    },
  ])('rejects a durable record that violates its $name', async ({ mutate }) => {
    const path = await databasePath()
    const first = await boot(path, [candidate()])
    await first.ctx.admission.reconcile({ source: 'startup' })
    await disposeTrackedContext(first.ctx)
    rewriteStoredState(path, mutate)

    const ctx = trackContext(
      await mountHostServices(path, {
        'dsh-autopilot': { trackerProvider: 'fixture', maxQueued: 20 },
      }),
    )
    await ctx.plugin(Tracker)
    await ctx.plugin(AutopilotConfig)

    await expect(ctx.plugin(Admission)).rejects.toThrow(/stored record.*does not match its schema/i)
    await disposeTrackedContext(ctx)
  })

  it.each([
    {
      name: 'deterministic run id',
      mutate(state: StoredAdmissionState) {
        const run = state.runs[0]
        if (run === undefined) throw new Error('expected a stored run')
        run.runId = 'run_00000000000000000000000000000000'
      },
    },
    {
      name: 'Brief digest',
      mutate(state: StoredAdmissionState) {
        const run = state.runs[0]
        if (run === undefined) throw new Error('expected a stored run')
        run.brief.content = `${run.brief.content}\ntampered`
      },
    },
    {
      name: 'next queue sequence',
      mutate(state: StoredAdmissionState) {
        state.nextSequence = Math.max(...state.runs.map((run) => run.queueSequence))
      },
    },
    {
      name: 'unique run id',
      mutate(state: StoredAdmissionState) {
        const run = state.runs[0]
        if (run === undefined) throw new Error('expected a stored run')
        state.runs.push({ ...structuredClone(run), queueSequence: state.nextSequence })
        state.nextSequence += 1
      },
    },
    {
      name: 'unique queue sequence',
      mutate(state: StoredAdmissionState) {
        const [firstRun, secondRun] = state.runs
        if (firstRun === undefined || secondRun === undefined) throw new Error('expected two stored runs')
        secondRun.queueSequence = firstRun.queueSequence
      },
    },
    {
      name: 'unique ingress id',
      mutate(state: StoredAdmissionState) {
        const receipt = state.acceptedIngress[0]
        if (receipt === undefined) throw new Error('expected a stored ingress receipt')
        state.acceptedIngress.push(receipt)
      },
    },
  ])('rejects a well-shaped durable record with inconsistent $name', async ({ mutate }) => {
    const path = await databasePath()
    const first = await boot(path, [
      candidate(),
      candidate({ issueId: trackerIssueId('issue-2'), displayKey: 'FIX-2' }),
    ])
    await first.ctx.admission.reconcile({ source: 'webhook', deliveryId: 'fixture:integrity-check' })
    await disposeTrackedContext(first.ctx)
    rewriteStoredState(path, mutate)

    const ctx = trackContext(
      await mountHostServices(path, {
        'dsh-autopilot': { trackerProvider: 'fixture', maxQueued: 20 },
      }),
    )
    await ctx.plugin(Tracker)
    await ctx.plugin(AutopilotConfig)

    await expect(ctx.plugin(Admission)).rejects.toThrow(/stored record.*does not match its schema/i)
    await disposeTrackedContext(ctx)
  })

  it('does not commit a run or ingress receipt when durable update fails', async () => {
    const path = await databasePath()
    const { ctx } = await boot(path, [candidate()])
    const before = ctx.admission.snapshot()
    rejectAdmissionUpdates(path)

    await expect(
      ctx.admission.reconcile({ source: 'webhook', deliveryId: 'fixture:delivery-failure' }),
    ).rejects.toThrow()
    expect(ctx.admission.snapshot()).toEqual(before)
    expect(ctx.admission.snapshot()).toMatchObject({
      revision: 0,
      runs: [],
      acceptedIngress: [],
      budget: { reservedTokens: 0, settledTokens: 0, usageUncertain: false },
    })
  })

  it('does not reserve or claim a run when the durable claim update fails', async () => {
    const path = await databasePath()
    const { ctx } = await boot(
      path,
      [candidate()],
      20,
      fixtureExecutionSettings('/tmp/fixture-target', '/tmp/fixture-worktrees'),
    )
    await ctx.admission.reconcile({ source: 'manual' })
    const before = ctx.admission.snapshot()
    rejectAdmissionUpdates(path)

    await expect(ctx.admission.claimNext()).rejects.toThrow()

    expect(ctx.admission.snapshot()).toEqual(before)
    expect(ctx.admission.snapshot()).toMatchObject({
      runs: [{ state: 'queued' }],
      budget: { reservedTokens: 0, settledTokens: 0, usageUncertain: false },
    })
  })

  it('does not release a reservation or publish an outcome when the durable settlement fails', async () => {
    const path = await databasePath()
    const { ctx } = await boot(
      path,
      [candidate()],
      20,
      fixtureExecutionSettings('/tmp/fixture-target', '/tmp/fixture-worktrees'),
    )
    await ctx.admission.reconcile({ source: 'manual' })
    const claimed = await ctx.admission.claimNext()
    if (claimed === undefined) throw new Error('expected a claimed run')
    await ctx.admission.recordWorktree(claimed.runId, {
      baseHead: 'a'.repeat(40),
      head: 'a'.repeat(40),
      status: '',
    })
    const before = ctx.admission.snapshot()
    rejectAdmissionUpdates(path)

    await expect(
      ctx.admission.settle(
        claimed.runId,
        { kind: 'failed', summary: 'Fixture settlement failure.', evidence: ['fixture'] },
        { kind: 'known', tokens: 10 },
      ),
    ).rejects.toThrow()

    expect(ctx.admission.snapshot()).toEqual(before)
    expect(ctx.admission.snapshot()).toMatchObject({
      runs: [{ state: 'implementing', budget: { reservedTokens: 60, settledTokens: 0 } }],
      budget: { reservedTokens: 60, settledTokens: 0, usageUncertain: false },
    })
  })

  it('bounds an uncertain provider-usage reason by UTF-8 bytes before durable settlement', async () => {
    const path = await databasePath()
    const { ctx } = await boot(
      path,
      [candidate()],
      20,
      fixtureExecutionSettings('/tmp/fixture-target', '/tmp/fixture-worktrees'),
    )
    await ctx.admission.reconcile({ source: 'manual' })
    const claimed = await ctx.admission.claimNext()
    if (claimed === undefined) throw new Error('expected a claimed run')

    const completed = await ctx.admission.settle(
      claimed.runId,
      { kind: 'failed', summary: 'Fixture usage failure.', evidence: ['fixture'] },
      { kind: 'uncertain', reason: '😀'.repeat(5000) },
    )

    expect(completed).toMatchObject({
      state: 'failed',
      budget: {
        reservedTokens: 60,
        settledTokens: 0,
        usageUncertain: true,
        usageUncertaintyReason: expect.any(String),
      },
      outcome: { kind: 'failed', summary: 'Provider token usage could not be settled safely.' },
    })
    expect(new TextEncoder().encode(completed.outcome.evidence[0]).byteLength).toBe(4096)
    expect(new TextEncoder().encode(completed.budget.usageUncertaintyReason ?? '').byteLength).toBe(4096)
  })
})
