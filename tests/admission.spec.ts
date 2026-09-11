import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { Admission } from '../src/admission.js'
import { createFixtureTrackerProvider } from '../src/testing.js'
import {
  readinessGeneration,
  Tracker,
  type TrackerComment,
  type TrackerIssueSnapshot,
  type TrackerProvider,
  trackerBindingId,
  trackerCommentId,
  trackerIssueId,
} from '../src/tracker.js'
import { disposeContext, fixtureExecutionSettings, mountHostServices } from './dsh-fixtures.js'

const temporaryDirectories: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(disposeContext))
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function trackContext(ctx: Context): Context {
  contexts.push(ctx)
  return ctx
}

async function disposeTrackedContext(ctx: Context): Promise<void> {
  const index = contexts.indexOf(ctx)
  if (index >= 0) contexts.splice(index, 1)
  await disposeContext(ctx)
}

const validBrief = `# Agent Brief

dsh-autopilot:brief:v1

## Objective
Implement durable tracker admission.

## In scope
The public admission service and fixture provider.

## Acceptance criteria
- Duplicate reconciliation produces one queued run.

## Constraints
Do not make external writes.

## Context
Issue #6 defines the product slice.`

function briefComment(overrides: Partial<TrackerComment> = {}): TrackerComment {
  return {
    id: trackerCommentId('comment-1'),
    authorId: 'person-1',
    body: validBrief,
    updatedAt: '2026-09-11T00:00:00.000Z',
    ...overrides,
  }
}

function candidate(overrides: Partial<TrackerIssueSnapshot> = {}): TrackerIssueSnapshot {
  return {
    bindingId: trackerBindingId('fixture:project'),
    issueId: trackerIssueId('issue-1'),
    displayKey: 'FIX-1',
    summary: 'Implement durable tracker admission',
    priorityRank: 2,
    isReady: true,
    labels: ['ready-for-agent'],
    comments: [briefComment()],
    dependencies: [],
    readiness: {
      kind: 'transition',
      generation: readinessGeneration('transition-1'),
      actorId: 'person-1',
      actorKind: 'human',
      occurredAt: '2026-09-11T00:00:00.000Z',
    },
    ...overrides,
  }
}

function fixtureProvider(issues: readonly TrackerIssueSnapshot[], onRead?: () => void): TrackerProvider {
  return createFixtureTrackerProvider({
    issues,
    readCandidates: () => {
      onRead?.()
      return Promise.resolve({ issues })
    },
  })
}

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-autopilot-admission-'))
  temporaryDirectories.push(directory)
  return join(directory, 'state.sqlite')
}

function useDatabase<T>(path: string, operation: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(path)
  try {
    return operation(database)
  } finally {
    database.close()
  }
}

function rejectAdmissionUpdates(path: string): void {
  useDatabase(path, (database) => {
    database.exec(`CREATE TRIGGER reject_admission_update
      BEFORE UPDATE ON u_autopilot_admission_state
      BEGIN
        SELECT RAISE(ABORT, 'forced durable failure');
      END`)
  })
}

interface StoredRun {
  runId: string
  providerId: string
  bindingId: string
  issueId: string
  readinessGeneration: string
  summary: string
  queueSequence: number
  brief: { commentId: string; content: string; digest: string }
}

interface StoredAdmissionState {
  schemaVersion: number
  nextSequence: number
  runs: StoredRun[]
  acceptedIngress: string[]
}

function rewriteStoredState(path: string, mutate: (state: StoredAdmissionState) => void): void {
  useDatabase(path, (database) => {
    const stored = database.prepare('SELECT value FROM u_autopilot_admission_state WHERE key = ?').get('primary') as {
      value: string
    }
    const state = JSON.parse(stored.value) as StoredAdmissionState
    mutate(state)
    database
      .prepare('UPDATE u_autopilot_admission_state SET value = ? WHERE key = ?')
      .run(JSON.stringify(state), 'primary')
  })
}

function deterministicRunId(run: StoredRun): string {
  const identity = JSON.stringify([run.providerId, run.bindingId, run.issueId, run.readinessGeneration])
  return `run_${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
}

async function boot(
  path: string,
  issues: readonly TrackerIssueSnapshot[],
  maxQueued = 20,
  admissionSettings: Record<string, unknown> = {},
  onRead?: () => void,
) {
  const ctx = trackContext(
    await mountHostServices(path, {
      'dsh-autopilot': {
        trackerProvider: 'fixture',
        maxQueued,
        ...admissionSettings,
      },
    }),
  )
  await ctx.plugin(Tracker)
  const disposeProvider = ctx.tracker.register(fixtureProvider(issues, onRead))
  await ctx.plugin(Admission)
  return { ctx, disposeProvider }
}

describe('admission service seam', () => {
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

  it('keeps dispatch disabled unless the fixture mode and positive limits are explicit', async () => {
    const { ctx } = await boot(await databasePath(), [candidate()])
    await ctx.admission.reconcile({ source: 'manual' })

    await expect(ctx.admission.claimNext()).rejects.toThrow(/dispatch is disabled/)

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

    const claims = await Promise.allSettled([ctx.admission.claimNext(), ctx.admission.claimNext()])

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
            worktreePath: expect.stringMatching(/\/run_[a-f0-9]{32}$/),
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

    await expect(ctx.plugin(Admission)).rejects.toThrow(/stored record.*does not match its schema/i)
    await disposeTrackedContext(ctx)
  })

  it('fails closed when a version-2 durable admission record is reopened', async () => {
    const path = await databasePath()
    const first = await boot(path, [candidate()])
    await first.ctx.admission.reconcile({ source: 'startup' })
    await disposeTrackedContext(first.ctx)
    rewriteStoredState(path, (state) => {
      state.schemaVersion = 2
    })

    const ctx = trackContext(
      await mountHostServices(path, {
        'dsh-autopilot': { trackerProvider: 'fixture', maxQueued: 20 },
      }),
    )
    await ctx.plugin(Tracker)

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
      budget: { reservedTokens: 60, settledTokens: 0, usageUncertain: true },
      outcome: { kind: 'failed', summary: 'Provider token usage could not be settled safely.' },
    })
    expect(new TextEncoder().encode(completed.outcome.evidence[0]).byteLength).toBe(4096)
  })
})
