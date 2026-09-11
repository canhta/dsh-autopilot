import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  type GenerateOptions,
  LlmAdapter,
  type LlmResolvedModelInfo,
  type StreamChunk,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { Admission } from '../src/admission.js'
import { Dispatch, FIXTURE_MODEL, FIXTURE_PROVIDER } from '../src/dispatch.js'
import { createFixtureTrackerProvider } from '../src/testing.js'
import {
  readinessGeneration,
  Tracker,
  type TrackerIssueSnapshot,
  trackerBindingId,
  trackerCommentId,
  trackerIssueId,
} from '../src/tracker.js'
import { disposeContext, mountExecutionHostServices } from './dsh-fixtures.js'

const temporaryDirectories: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(disposeContext))
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

class ControlledAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private response = 0

  constructor(
    private readonly reportKind: 'verified' | 'blocked' | 'failed' = 'verified',
    private readonly usageMode: 'known' | 'missing' | 'over' = 'known',
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.response += 1
    if (this.response === 1) {
      const id = ToolCallId('report-1')
      const argumentsJson = JSON.stringify({
        kind: this.reportKind,
        summary: 'The fixture run completed and its clean Git state was verified.',
        evidence: ['controlled-model', 'clean-worktree'],
      })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name: 'autopilot_report', arguments: argumentsJson },
      }
      if (this.usageMode !== 'missing') {
        yield {
          type: 'usage',
          usage:
            this.usageMode === 'over'
              ? { inputTokens: 70, outputTokens: 3, cacheReadTokens: 2 }
              : { inputTokens: 7, outputTokens: 3, cacheReadTokens: 2 },
        }
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    if (this.usageMode !== 'missing') yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const brief = `# Agent Brief

dsh-autopilot:brief:v1

## Objective
Exercise one durable fixture dispatch.

## In scope
The managed worktree, native Agent and structured completion report.

## Acceptance criteria
- The controlled model reports a verified outcome.

## Constraints
Use only the fixture model route.

## Context
Issue #7 defines this execution slice.`

function candidate(): TrackerIssueSnapshot {
  return {
    bindingId: trackerBindingId('fixture:project'),
    issueId: trackerIssueId('issue-7'),
    displayKey: 'FIX-7',
    summary: 'Exercise durable dispatch',
    priorityRank: 1,
    isReady: true,
    labels: ['ready-for-agent'],
    comments: [
      {
        id: trackerCommentId('brief-7'),
        authorId: 'person-1',
        body: brief,
        updatedAt: '2026-09-11T00:00:00.000Z',
      },
    ],
    dependencies: [],
    readiness: {
      kind: 'transition',
      generation: readinessGeneration('transition-7'),
      actorId: 'person-1',
      actorKind: 'human',
      occurredAt: '2026-09-11T00:00:00.000Z',
    },
  }
}

function restartCandidate(): TrackerIssueSnapshot {
  const issue = candidate()
  return {
    ...issue,
    bindingId: trackerBindingId('fixture:restart'),
    issueId: trackerIssueId('issue-7-restart'),
    displayKey: 'FIX-7-RESTART',
    readiness: {
      kind: 'transition',
      generation: readinessGeneration('transition-7-restart'),
      actorId: 'person-1',
      actorKind: 'human',
      occurredAt: '2026-09-11T00:00:00.000Z',
    },
  }
}

async function createTargetRepository(root: string): Promise<string> {
  const repository = join(root, 'target')
  await mkdir(repository)
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repository })
  execFileSync('git', ['config', 'user.name', 'Fixture User'], { cwd: repository })
  execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository })
  await writeFile(join(repository, 'README.md'), 'fixture\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repository })
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repository })
  return repository
}

async function bootFixture(root: string, adapter: ControlledAdapter): Promise<Context> {
  const repository = await createTargetRepository(root)
  const worktreeRoot = join(root, 'worktrees')
  const sessionRoot = join(root, 'sessions')
  await mkdir(worktreeRoot)
  await mkdir(sessionRoot)
  const ctx = await mountExecutionHostServices(join(root, 'state.sqlite'), sessionRoot, {
    'dsh-autopilot': {
      trackerProvider: 'fixture',
      executionMode: 'fixture',
      targetRepository: repository,
      targetBaseBranch: 'main',
      managedWorktreeRoot: worktreeRoot,
      deploymentTokenCap: 100,
      perRunTokenCap: 60,
      runTokenAllowance: 60,
    },
  })
  contexts.push(ctx)
  ctx.llm.registerAdapter([FIXTURE_PROVIDER], adapter)
  await ctx.plugin(Tracker)
  ctx.tracker.register(createFixtureTrackerProvider({ issues: [candidate()] }))
  await ctx.plugin(Admission)
  await ctx.plugin(Dispatch)
  await ctx.admission.reconcile({ source: 'manual' })
  return ctx
}

describe('durable fixture dispatch', () => {
  it('runs one native Agent in a managed worktree and settles reported usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-dispatch-'))
    temporaryDirectories.push(root)
    const adapter = new ControlledAdapter()
    const ctx = await bootFixture(root, adapter)

    const completed = await ctx.dispatch.dispatchNext()

    if (completed === undefined || completed.execution.git === undefined) {
      throw new Error('fixture dispatch did not retain its terminal Git facts')
    }

    expect(completed).toMatchObject({
      state: 'publishing',
      outcome: {
        kind: 'verified',
        summary: 'The fixture run completed and its clean Git state was verified.',
        evidence: ['controlled-model', 'clean-worktree'],
      },
      budget: { capTokens: 60, reservedTokens: 0, settledTokens: 18, usageUncertain: false },
    })
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests.every((request) => request.provider === FIXTURE_PROVIDER)).toBe(true)
    expect(adapter.requests.every((request) => request.model === FIXTURE_MODEL)).toBe(true)
    expect(adapter.requests.every((request) => request.sessionId === completed?.execution.sessionId)).toBe(true)

    const snapshot = ctx.admission.snapshot()
    expect(snapshot.budget).toEqual({ reservedTokens: 0, settledTokens: 18, usageUncertain: false })
    expect(snapshot.runs).toEqual([completed])

    const worktreePath = completed.execution.worktreePath
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: worktreePath, encoding: 'utf8' })).toBe('')
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim()).toBe(
      completed.execution.git.head,
    )
    expect(await readFile(join(worktreePath, 'README.md'), 'utf8')).toBe('fixture\n')

    const workspaces = ctx.workspaceRegistry.list()
    expect(workspaces.map((entry) => ({ path: entry.path, sessionIds: entry.sessionIds }))).toContainEqual({
      path: await realpath(worktreePath),
      sessionIds: expect.arrayContaining([completed.execution.sessionId]) as unknown,
    })
    await expect(ctx.sessionPersistence.stat(completed.execution.sessionId)).resolves.toMatchObject({
      header: { id: completed.execution.sessionId },
    })
  })

  it.each([
    ['blocked', 'blocked'],
    ['failed', 'failed'],
  ] as const)('maps a %s report to the durable %s lifecycle state', async (reportKind, expectedState) => {
    const root = await mkdtemp(join(tmpdir(), `dsh-autopilot-${reportKind}-`))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter(reportKind))

    const completed = await ctx.dispatch.dispatchNext()

    expect(completed).toMatchObject({ state: expectedState, outcome: { kind: reportKind } })
  })

  it('retains the reservation and stops later authorization when provider usage is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-usage-unknown-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter('verified', 'missing'))

    const completed = await ctx.dispatch.dispatchNext()

    expect(completed).toMatchObject({
      state: 'failed',
      outcome: { kind: 'failed', summary: 'Provider token usage could not be settled safely.' },
      budget: { reservedTokens: 60, settledTokens: 0, usageUncertain: true },
    })
    expect(ctx.admission.snapshot().budget).toEqual({
      reservedTokens: 60,
      settledTokens: 0,
      usageUncertain: true,
    })
    await expect(ctx.admission.claimNext()).rejects.toThrow(/token usage is uncertain/)
  })

  it('fails closed when reported provider usage exceeds the reserved allowance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-usage-over-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter('verified', 'over'))

    const completed = await ctx.dispatch.dispatchNext()

    expect(completed).toMatchObject({
      state: 'failed',
      outcome: {
        kind: 'failed',
        evidence: ['reported usage exceeded the reserved allowance'],
      },
      budget: { reservedTokens: 60, settledTokens: 0, usageUncertain: true },
    })
    await expect(ctx.admission.claimNext()).rejects.toThrow(/token usage is uncertain/)
  })

  it('marks an abruptly interrupted run for explicit recovery without duplicating its worktree or Session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-restart-'))
    temporaryDirectories.push(root)
    const repository = await createTargetRepository(root)
    await mkdir(join(root, 'worktrees'))
    await mkdir(join(root, 'sessions'))
    const crash = spawnSync(
      join(process.cwd(), 'node_modules/.bin/vitest'),
      ['run', 'tests/fixtures/crash-dispatch.spec.ts', '--maxWorkers=1', '--pool=threads'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DSH_AUTOPILOT_CRASH_ROOT: root,
          DSH_AUTOPILOT_CRASH_REPOSITORY: repository,
        },
        encoding: 'utf8',
        timeout: 30_000,
      },
    )
    expect(crash.signal ?? crash.status).not.toBe(0)

    const ctx = await mountExecutionHostServices(join(root, 'state.sqlite'), join(root, 'sessions'), {
      'dsh-autopilot': {
        trackerProvider: 'fixture',
        executionMode: 'fixture',
        targetRepository: repository,
        targetBaseBranch: 'main',
        managedWorktreeRoot: join(root, 'worktrees'),
        deploymentTokenCap: 100,
        perRunTokenCap: 60,
        runTokenAllowance: 60,
      },
    })
    contexts.push(ctx)
    await ctx.plugin(Tracker)
    ctx.tracker.register(createFixtureTrackerProvider({ issues: [restartCandidate()] }))
    await ctx.plugin(Admission)

    const interrupted = ctx.admission.snapshot().runs[0]
    if (interrupted === undefined) {
      throw new Error(
        `crash fixture did not persist a run (status=${String(crash.status)}, signal=${String(crash.signal)}): ${crash.stderr}`,
      )
    }
    expect(interrupted).toMatchObject({
      state: 'implementing',
      execution: {
        recovery: { kind: 'required', reason: 'host-restart' },
        git: { head: expect.stringMatching(/^[a-f0-9]{40}$/), status: '' },
      },
      budget: { reservedTokens: 60, settledTokens: 0, usageUncertain: false },
    })
    if (interrupted.state !== 'implementing' || interrupted.execution.git === undefined) {
      throw new Error('interrupted run did not retain its durable execution identities')
    }
    expect(
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: interrupted.execution.worktreePath, encoding: 'utf8' }).trim(),
    ).toBe(interrupted.execution.git.head)
    await expect(ctx.sessionPersistence.stat(interrupted.execution.sessionId)).resolves.toMatchObject({
      header: { id: interrupted.execution.sessionId },
    })
    const reconciled = await ctx.admission.reconcile({ source: 'startup' })
    expect(reconciled.decisions).toEqual([{ displayKey: 'FIX-7-RESTART', outcome: 'duplicate' }])
    expect(reconciled.runs).toHaveLength(1)
    await expect(ctx.admission.claimNext()).resolves.toBeUndefined()
    expect(ctx.admission.snapshot().runs.filter((run) => run.displayKey === 'FIX-7-RESTART')).toHaveLength(1)
  })
})
