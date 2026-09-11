import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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
import { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { Admission, type PausedActiveRun } from '../src/admission.js'
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
import {
  Deferred,
  disposeContext,
  executionAgentRegistryFiber,
  fixtureExecutionSettings,
  mountExecutionHostServices,
  remountExecutionAgentRegistry,
} from './dsh-fixtures.js'

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
    private readonly reportMode:
      | 'valid'
      | 'missing'
      | 'malformed'
      | 'multiple'
      | 'empty'
      | 'exact-multibyte'
      | 'oversized' = 'valid',
    private readonly beforeFirstResponse?: () => Promise<void>,
    private readonly reportOnResume = false,
    private readonly firstUnapprovedTool?: string,
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.response += 1
    if (this.response === 1) await this.beforeFirstResponse?.()

    if (this.response === 1 && this.firstUnapprovedTool !== undefined) {
      yield* this.toolResponse(`unapproved-${String(this.response)}`, this.firstUnapprovedTool, {})
      return
    }

    if (this.reportMode === 'missing') {
      yield* this.textResponse()
      return
    }

    if (
      this.response === 1 ||
      (this.firstUnapprovedTool !== undefined && this.response === 2) ||
      (this.reportOnResume && this.response === 3) ||
      (this.reportMode === 'multiple' && this.response === 2)
    ) {
      const { head, status } = managedGitFrom(options)
      const summary =
        this.reportMode === 'empty'
          ? ''
          : this.reportMode === 'exact-multibyte'
            ? '😀'.repeat(1024)
            : this.reportMode === 'oversized'
              ? '😀'.repeat(1025)
              : 'The fixture run completed and its clean Git state was verified.'
      const report: Record<string, unknown> = {
        kind: this.reportKind,
        summary,
        evidence: this.reportMode === 'malformed' ? [1] : ['controlled-model', 'clean-worktree'],
      }
      if (this.reportKind === 'verified') Object.assign(report, { gitHead: head, gitStatus: status })
      yield* this.toolResponse(`report-${String(this.response)}`, 'autopilot_report', report)
      return
    }

    yield* this.textResponse()
  }

  private *toolResponse(id: string, name: string, args: Record<string, unknown>): Iterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield {
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id: ToolCallId(id),
        name,
        arguments: JSON.stringify(args),
      },
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
  }

  private *textResponse(): Iterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    if (this.usageMode !== 'missing') yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function managedGitFrom(options: GenerateOptions): { head: string; status: string } {
  const text = options.messages
    .flatMap((message) => message.content)
    .filter(
      (block): block is Extract<(typeof options.messages)[number]['content'][number], { type: 'text' }> =>
        block.type === 'text',
    )
    .map((block) => block.text)
    .join('\n')
  const match = /Managed Git head: ([a-f0-9]{40,64})\nManaged Git status: ("(?:[^"\\]|\\.)*")/.exec(text)
  if (match?.[1] === undefined || match[2] === undefined) throw new Error('fixture request omitted managed Git facts')
  return { head: match[1], status: JSON.parse(match[2]) as string }
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

function candidate(overrides: Partial<TrackerIssueSnapshot> = {}): TrackerIssueSnapshot {
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
    ...overrides,
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

async function bootFixture(
  root: string,
  adapter: ControlledAdapter,
  issues: readonly TrackerIssueSnapshot[] = [candidate()],
): Promise<Context> {
  const repository = await createTargetRepository(root)
  const worktreeRoot = join(root, 'worktrees')
  const sessionRoot = join(root, 'sessions')
  await mkdir(worktreeRoot)
  await mkdir(sessionRoot)
  const ctx = await mountExecutionHostServices(join(root, 'state.sqlite'), sessionRoot, {
    'dsh-autopilot': {
      trackerProvider: 'fixture',
      ...fixtureExecutionSettings(repository, worktreeRoot),
    },
  })
  contexts.push(ctx)
  ctx.llm.registerAdapter([FIXTURE_PROVIDER], adapter)
  await ctx.plugin(Tracker)
  ctx.tracker.register(createFixtureTrackerProvider({ issues }))
  await ctx.plugin(Admission)
  await ctx.plugin(Dispatch)
  await ctx.admission.reconcile({ source: 'manual' })
  return ctx
}

async function pauseAtSettlement(ctx: Context): Promise<PausedActiveRun> {
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
  if (paused === undefined || paused.state !== 'paused' || paused.pause.kind !== 'active') {
    throw new Error('expected an allocated pause checkpoint')
  }
  return paused
}

describe('durable fixture dispatch', () => {
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

  it('continues a paused logical run through the retained DSH Session and worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-dispatch-resume-'))
    temporaryDirectories.push(root)
    const adapter = new ControlledAdapter('verified', 'known', 'valid', undefined, true)
    const ctx = await bootFixture(root, adapter)
    const createAgent = ctx.agents.create.bind(ctx.agents)
    const resumeAgent = ctx.agents.resume.bind(ctx.agents)
    let creates = 0
    let resumes = 0
    ctx.agents.create = async (options) => {
      creates += 1
      return await createAgent(options)
    }
    ctx.agents.resume = async (options) => {
      resumes += 1
      return await resumeAgent(options)
    }
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
    if (paused === undefined || paused.state !== 'paused' || paused.pause.kind !== 'active') {
      throw new Error('expected an allocated pause checkpoint')
    }
    const worktreesBefore = await readdir(join(root, 'worktrees'))
    const branchesBefore = execFileSync('git', ['branch', '--format=%(refname:short)'], {
      cwd: paused.execution.targetRepository,
      encoding: 'utf8',
    })

    await ctx.admission.requestRunPause(paused.runId)
    await ctx.admission.setSchedulerMode('enabled')
    const completed = await ctx.dispatch.resumeRun(paused.runId)

    expect(completed).toMatchObject({
      runId: paused.runId,
      state: 'publishing',
      execution: {
        attempt: 2,
        sessionId: paused.execution.sessionId,
        worktreePath: paused.execution.worktreePath,
        branch: paused.execution.branch,
      },
      budget: { capTokens: 60, reservedTokens: 0, settledTokens: 36, usageUncertain: false },
      outcome: { kind: 'verified' },
    })
    expect(creates).toBe(1)
    expect(resumes).toBe(1)
    expect(await readdir(join(root, 'worktrees'))).toEqual(worktreesBefore)
    expect(
      execFileSync('git', ['branch', '--format=%(refname:short)'], {
        cwd: paused.execution.targetRepository,
        encoding: 'utf8',
      }),
    ).toBe(branchesBefore)
    expect(adapter.requests).toHaveLength(4)
    expect(adapter.requests.every((request) => request.sessionId === paused.execution.sessionId)).toBe(true)
  })

  it('leaves an allocated pause unchanged when its retained Session is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-dispatch-missing-session-'))
    temporaryDirectories.push(root)
    const adapter = new ControlledAdapter()
    const ctx = await bootFixture(root, adapter)
    const paused = await pauseAtSettlement(ctx)
    await ctx.admission.setSchedulerMode('enabled')
    const before = ctx.admission.snapshot()
    ctx.sessionPersistence.stat = () => Promise.resolve(undefined)

    await expect(ctx.dispatch.resumeRun(paused.runId)).rejects.toThrow(/Session.*unavailable.*recovery/i)

    expect(ctx.admission.snapshot()).toMatchObject({
      revision: before.revision + 1,
      runs: [{ runId: paused.runId, state: 'paused', execution: { recovery: { reason: 'session-unavailable' } } }],
    })
    expect(adapter.requests).toHaveLength(2)
    expect(ctx.agents.roots()).toEqual([])
  })

  it('leaves an allocated pause unchanged when its retained Session belongs to another working directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-dispatch-session-cwd-'))
    temporaryDirectories.push(root)
    const adapter = new ControlledAdapter()
    const ctx = await bootFixture(root, adapter)
    const paused = await pauseAtSettlement(ctx)
    await ctx.admission.setSchedulerMode('enabled')
    const before = ctx.admission.snapshot()
    const stat = ctx.sessionPersistence.stat.bind(ctx.sessionPersistence)
    ctx.sessionPersistence.stat = async (sessionId, options) => {
      const persisted = await stat(sessionId, options)
      if (persisted === undefined) return undefined
      return { ...persisted, header: { ...persisted.header, cwd: join(root, 'different-worktree') } }
    }

    await expect(ctx.dispatch.resumeRun(paused.runId)).rejects.toThrow(/Session.*incompatible.*recovery/i)

    expect(ctx.admission.snapshot()).toMatchObject({
      revision: before.revision + 1,
      runs: [{ runId: paused.runId, state: 'paused', execution: { recovery: { reason: 'session-unavailable' } } }],
    })
    expect(adapter.requests).toHaveLength(2)
    expect(ctx.agents.roots()).toEqual([])
  })

  it('skips a recovery-blocked active pause when scheduler dispatch can start new work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-dispatch-recovery-skip-'))
    temporaryDirectories.push(root)
    const adapter = new ControlledAdapter('verified', 'known', 'valid', undefined, true)
    const newIssue = candidate({
      bindingId: trackerBindingId('fixture:recovery-new'),
      issueId: trackerIssueId('issue-recovery-new'),
      displayKey: 'FIX-RECOVERY-NEW',
      priorityRank: 9,
      readiness: {
        kind: 'transition',
        generation: readinessGeneration('transition-recovery-new'),
        actorId: 'person-1',
        actorKind: 'human',
        occurredAt: '2026-09-11T00:00:00.000Z',
      },
    })
    const ctx = await bootFixture(root, adapter, [candidate(), newIssue])
    const paused = await pauseAtSettlement(ctx)
    await ctx.admission.setSchedulerMode('enabled')
    const stat = ctx.sessionPersistence.stat.bind(ctx.sessionPersistence)
    ctx.sessionPersistence.stat = (sessionId, options) =>
      sessionId === paused.execution.sessionId ? Promise.resolve(undefined) : stat(sessionId, options)
    await expect(ctx.dispatch.resumeRun(paused.runId)).rejects.toThrow(/Session.*recovery/i)

    const completed = await ctx.dispatch.dispatchNext()

    expect(completed).toMatchObject({ displayKey: 'FIX-RECOVERY-NEW', state: 'publishing' })
    expect(ctx.admission.snapshot().runs.find((run) => run.runId === paused.runId)).toMatchObject({
      state: 'paused',
      execution: { recovery: { reason: 'session-unavailable' } },
    })
  })

  it('leaves an allocated pause unchanged when its durable workspace ownership is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-dispatch-workspace-owner-'))
    temporaryDirectories.push(root)
    const adapter = new ControlledAdapter()
    const ctx = await bootFixture(root, adapter)
    const paused = await pauseAtSettlement(ctx)
    await ctx.admission.setSchedulerMode('enabled')
    const before = ctx.admission.snapshot()
    ctx.workspaceRegistry.resolveByPath = () => Promise.resolve(undefined)

    await expect(ctx.dispatch.resumeRun(paused.runId)).rejects.toThrow(/workspace ownership.*recovery/i)

    expect(ctx.admission.snapshot()).toMatchObject({
      revision: before.revision + 1,
      runs: [{ runId: paused.runId, state: 'paused', execution: { recovery: { reason: 'workspace-unavailable' } } }],
    })
    expect(adapter.requests).toHaveLength(2)
    expect(ctx.agents.roots()).toEqual([])
  })

  it('leaves an allocated pause unchanged when its retained Git state changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-dispatch-changed-git-'))
    temporaryDirectories.push(root)
    const adapter = new ControlledAdapter()
    const ctx = await bootFixture(root, adapter)
    const paused = await pauseAtSettlement(ctx)
    await writeFile(join(paused.execution.worktreePath, 'CHANGED.md'), 'changed after checkpoint\n')
    await ctx.admission.setSchedulerMode('enabled')
    const before = ctx.admission.snapshot()

    await expect(ctx.dispatch.resumeRun(paused.runId)).rejects.toThrow(/Git state changed.*recovery/i)

    expect(ctx.admission.snapshot()).toMatchObject({
      revision: before.revision + 1,
      runs: [{ runId: paused.runId, state: 'paused', execution: { recovery: { reason: 'worktree-mismatch' } } }],
    })
    expect(adapter.requests).toHaveLength(2)
    expect(ctx.agents.roots()).toEqual([])
  })

  it('rejects a replacement repository even when its branch, head, and status match the checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-dispatch-replaced-worktree-'))
    temporaryDirectories.push(root)
    const adapter = new ControlledAdapter()
    const ctx = await bootFixture(root, adapter)
    const paused = await pauseAtSettlement(ctx)
    execFileSync('git', ['worktree', 'remove', '--force', paused.execution.worktreePath], {
      cwd: paused.execution.targetRepository,
    })
    execFileSync(
      'git',
      ['clone', '--branch', paused.execution.branch, paused.execution.targetRepository, paused.execution.worktreePath],
      { cwd: root },
    )
    await ctx.admission.setSchedulerMode('enabled')
    const before = ctx.admission.snapshot()

    await expect(ctx.dispatch.resumeRun(paused.runId)).rejects.toThrow(/worktree.*incompatible.*recovery/i)

    expect(ctx.admission.snapshot()).toMatchObject({
      revision: before.revision + 1,
      runs: [{ runId: paused.runId, state: 'paused', execution: { recovery: { reason: 'worktree-mismatch' } } }],
    })
    expect(adapter.requests).toHaveLength(2)
    expect(ctx.agents.roots()).toEqual([])
  })

  it('disposes a resumed root when workspace attachment fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-dispatch-resume-attach-'))
    temporaryDirectories.push(root)
    const adapter = new ControlledAdapter()
    const ctx = await bootFixture(root, adapter)
    const paused = await pauseAtSettlement(ctx)
    const workspace = await ctx.workspaceRegistry.resolveByPath(paused.execution.worktreePath)
    if (workspace === undefined) throw new Error('expected retained workspace')
    workspace.attachSession = () => Promise.reject(new Error('controlled workspace attachment failure'))
    await ctx.admission.setSchedulerMode('enabled')

    const failed = await ctx.dispatch.resumeRun(paused.runId)

    expect(failed).toMatchObject({ state: 'failed', outcome: { kind: 'failed' } })
    expect(ctx.agents.roots()).toEqual([])
  })

  it('automatically resumes an eligible scheduler pause before claiming new work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-dispatch-resume-priority-'))
    temporaryDirectories.push(root)
    const adapter = new ControlledAdapter('verified', 'known', 'valid', undefined, true)
    const newIssue = candidate({
      bindingId: trackerBindingId('fixture:new'),
      issueId: trackerIssueId('issue-new'),
      displayKey: 'FIX-NEW',
      priorityRank: 9,
      readiness: {
        kind: 'transition',
        generation: readinessGeneration('transition-new'),
        actorId: 'person-1',
        actorKind: 'human',
        occurredAt: '2026-09-11T00:00:00.000Z',
      },
    })
    const ctx = await bootFixture(root, adapter, [candidate(), newIssue])
    const paused = await pauseAtSettlement(ctx)
    await ctx.admission.setSchedulerMode('enabled')

    const completed = await ctx.dispatch.dispatchNext()

    expect(completed).toMatchObject({ runId: paused.runId, state: 'publishing', execution: { attempt: 2 } })
    expect(ctx.admission.snapshot().runs.find((run) => run.displayKey === 'FIX-NEW')).toMatchObject({ state: 'queued' })
  })

  it('continues a durable pause through the same Session after a real Host restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-dispatch-resume-restart-'))
    temporaryDirectories.push(root)
    const adapter = new ControlledAdapter('verified', 'known', 'valid', undefined, true)
    const first = await bootFixture(root, adapter)
    const paused = await pauseAtSettlement(first)
    contexts.splice(contexts.indexOf(first), 1)
    await disposeContext(first)

    const resumed = await mountExecutionHostServices(join(root, 'state.sqlite'), join(root, 'sessions'), {
      'dsh-autopilot': {
        trackerProvider: 'fixture',
        ...fixtureExecutionSettings(paused.execution.targetRepository, join(root, 'worktrees')),
      },
    })
    contexts.push(resumed)
    resumed.llm.registerAdapter([FIXTURE_PROVIDER], adapter)
    await resumed.plugin(Tracker)
    resumed.tracker.register(createFixtureTrackerProvider({ issues: [candidate()] }))
    await resumed.plugin(Admission)
    await resumed.plugin(Dispatch)
    const resumeAgent = resumed.agents.resume.bind(resumed.agents)
    let resumes = 0
    resumed.agents.resume = async (options) => {
      resumes += 1
      return await resumeAgent(options)
    }
    await resumed.admission.setSchedulerMode('enabled')

    const completed = await resumed.dispatch.dispatchNext()

    expect(completed).toMatchObject({
      runId: paused.runId,
      state: 'publishing',
      execution: {
        attempt: 2,
        sessionId: paused.execution.sessionId,
        worktreePath: paused.execution.worktreePath,
        branch: paused.execution.branch,
      },
      budget: { reservedTokens: 0, settledTokens: 36, usageUncertain: false },
    })
    expect(resumes).toBe(1)
    expect(adapter.requests.every((request) => request.sessionId === paused.execution.sessionId)).toBe(true)
    expect(resumed.agents.roots()).toEqual([])
  })

  it('does not let scheduler resume clear an active operator hold', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-dispatch-operator-hold-'))
    temporaryDirectories.push(root)
    const adapter = new ControlledAdapter()
    const ctx = await bootFixture(root, adapter)
    const paused = await pauseAtSettlement(ctx)
    await ctx.admission.requestRunPause(paused.runId)
    await ctx.admission.setSchedulerMode('enabled')

    await expect(ctx.dispatch.dispatchNext()).resolves.toBeUndefined()

    expect(ctx.admission.snapshot().runs[0]).toMatchObject({
      state: 'paused',
      pause: { kind: 'active', reason: 'operator', operatorHold: true },
    })
    expect(adapter.requests).toHaveLength(2)
  })

  it('does not claim or start a queued run while the scheduler is draining', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-dispatch-draining-'))
    temporaryDirectories.push(root)
    const adapter = new ControlledAdapter()
    const ctx = await bootFixture(root, adapter)
    await ctx.admission.setSchedulerMode('draining')
    const before = ctx.admission.snapshot()

    await expect(ctx.dispatch.dispatchNext()).resolves.toBeUndefined()

    expect(ctx.admission.snapshot()).toEqual(before)
    expect(ctx.admission.snapshot()).toMatchObject({
      scheduler: { mode: 'draining' },
      runs: [{ state: 'queued' }],
      budget: { reservedTokens: 0, settledTokens: 0, usageUncertain: false },
    })
    expect(adapter.requests).toEqual([])
    expect(await readdir(join(root, 'worktrees'))).toEqual([])
  })

  it('runs one native Agent in a managed worktree and settles reported usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-dispatch-'))
    temporaryDirectories.push(root)
    const adapter = new ControlledAdapter()
    const ctx = await bootFixture(root, adapter)

    const completed = await ctx.dispatch.dispatchNext()

    if (completed === undefined || completed.state === 'paused' || completed.execution.git === undefined) {
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
    ;(completed.outcome.evidence as string[]).push('caller mutation')
    expect(ctx.admission.snapshot().runs[0]).not.toMatchObject({
      outcome: { evidence: expect.arrayContaining(['caller mutation']) as unknown },
    })

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

  it('rejects a renamed Host-global delegation tool before it can create a descendant', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-dispatch-delegation-denied-'))
    temporaryDirectories.push(root)
    const toolName = 'configured_delegation_name'
    const adapter = new ControlledAdapter('verified', 'known', 'valid', undefined, false, toolName)
    const ctx = await bootFixture(root, adapter)
    let delegated = false
    ctx.tools.register(
      defineTool({
        name: toolName,
        description: 'A fixture stand-in for a deployment-configured delegation tool.',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: () => [{ type: 'text', text: 'delegated' }],
        },
        execute() {
          delegated = true
          return Promise.resolve('delegated')
        },
      }),
    )

    const completed = await ctx.dispatch.dispatchNext()

    expect(completed).toMatchObject({ state: 'publishing', budget: { usageUncertain: false } })
    expect(adapter.requests).toHaveLength(3)
    expect(
      adapter.requests.every((request) => request.tools?.map((tool) => tool.name).join(',') === 'autopilot_report'),
    ).toBe(true)
    expect(delegated).toBe(false)
    expect(ctx.agents.list()).toEqual([])
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

  it.each(['missing', 'malformed', 'multiple', 'empty', 'oversized'] as const)(
    'fails closed when the terminal report is %s',
    async (reportMode) => {
      const root = await mkdtemp(join(tmpdir(), `dsh-autopilot-report-${reportMode}-`))
      temporaryDirectories.push(root)
      const ctx = await bootFixture(root, new ControlledAdapter('verified', 'known', reportMode))

      const completed = await ctx.dispatch.dispatchNext()

      expect(completed).toMatchObject({ state: 'failed', outcome: { kind: 'failed' } })
      if (completed === undefined || completed.state === 'paused') throw new Error('expected a failed terminal run')
      expect(completed?.outcome.summary).toMatch(/did not submit|violated/)
    },
  )

  it('accepts a report summary at the exact multibyte durable boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-report-exact-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter('verified', 'known', 'exact-multibyte'))

    const completed = await ctx.dispatch.dispatchNext()

    expect(completed).toMatchObject({ state: 'publishing', outcome: { kind: 'verified' } })
    if (completed === undefined || completed.state === 'paused') throw new Error('expected a publishing terminal run')
    expect(new TextEncoder().encode(completed?.outcome.summary).byteLength).toBe(4096)
  })

  it('rejects verification when the reported Git facts differ from the final managed worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-report-git-mismatch-'))
    temporaryDirectories.push(root)
    const adapter = new ControlledAdapter('verified', 'known', 'valid', async () => {
      const entries = await readdir(join(root, 'worktrees'))
      const worktree = entries[0]
      if (worktree === undefined) throw new Error('fixture worktree was not created')
      await writeFile(join(root, 'worktrees', worktree, 'UNCOMMITTED.md'), 'uncommitted fixture change\n')
    })
    const ctx = await bootFixture(root, adapter)

    const completed = await ctx.dispatch.dispatchNext()

    expect(completed).toMatchObject({
      state: 'failed',
      outcome: {
        kind: 'failed',
        summary: 'The fixture model reported Git facts that do not match the managed worktree.',
      },
      execution: { git: { status: '?? UNCOMMITTED.md\n' } },
    })
  })

  it('bounds retained Git mismatch evidence by UTF-8 bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-report-git-bound-'))
    temporaryDirectories.push(root)
    const adapter = new ControlledAdapter('verified', 'known', 'valid', async () => {
      const entries = await readdir(join(root, 'worktrees'))
      const worktree = entries[0]
      if (worktree === undefined) throw new Error('fixture worktree was not created')
      await Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          writeFile(
            join(root, 'worktrees', worktree, `UNCOMMITTED-${String(index).padStart(3, '0')}-${'x'.repeat(40)}.md`),
            'fixture change\n',
          ),
        ),
      )
    })
    const ctx = await bootFixture(root, adapter)

    const completed = await ctx.dispatch.dispatchNext()

    if (completed === undefined || completed.state === 'paused') throw new Error('expected a terminal fixture run')
    expect(completed).toMatchObject({ state: 'failed', outcome: { kind: 'failed' } })
    expect(new TextEncoder().encode(completed.outcome.evidence[0]).byteLength).toBe(4096)
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
        ...fixtureExecutionSettings(repository, join(root, 'worktrees')),
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
