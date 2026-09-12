import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Admission } from '../src/admission.js'
import { AutopilotConfig } from '../src/config.js'
import { AutopilotOperations, PullRequestDispositionRegistry, RuntimeOwner } from '../src/operations.js'
import { createFixtureTrackerProvider } from '../src/testing.js'
import { readinessGeneration, Tracker, trackerBindingId, trackerIssueId } from '../src/tracker.js'
import {
  bootFixture,
  ControlledAdapter,
  candidate,
  contexts,
  mountExecutionLifecycle,
  pauseAtSettlement,
  temporaryDirectories,
} from './dispatch-fixtures.js'
import {
  Deferred,
  disposeContext,
  FIXTURE_PROVIDER,
  fixtureExecutionSettings,
  mountExecutionHostServices,
  mountedFixturePresets,
  setFixtureAgentDefaults,
  setFixturePresetContent,
} from './dsh-fixtures.js'

describe('durable fixture dispatch: recovery and resume', () => {
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

    setFixtureAgentDefaults(ctx, { provider: 'changed-after-claim', model: 'changed-model' }, 'changed-preset')

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
    expect(adapter.requests.every((request) => request.provider === paused.execution.agent?.model.provider)).toBe(true)
    expect(adapter.requests.every((request) => request.model === paused.execution.agent?.model.model)).toBe(true)
    expect(mountedFixturePresets(ctx)).toEqual([paused.execution.agent?.presetId, paused.execution.agent?.presetId])
  })

  it('keeps an operator resume paused while operations recovery is unresolved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-operator-resume-recovery-'))
    temporaryDirectories.push(root)
    const adapter = new ControlledAdapter('verified', 'known', 'valid', undefined, true)
    const ctx = await bootFixture(root, adapter)
    const paused = await pauseAtSettlement(ctx)
    await ctx.admission.setSchedulerMode('enabled')
    ctx.autopilotOperations.registerRecoveryParticipant('operator-resume-probe', {
      reconcile: () => Promise.resolve({ pending: 1 }),
    })

    await expect(ctx.dispatch.resumeRun(paused.runId)).rejects.toThrow(/recovery.*before.*execution/i)

    expect(ctx.admission.snapshot().runs.find((run) => run.runId === paused.runId)).toMatchObject({
      state: 'paused',
      execution: { attempt: 1 },
    })
    expect(adapter.requests).toHaveLength(2)
  })

  it('requires explicit recovery when the retained Agent preset content changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-preset-change-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter('verified', 'known', 'valid', undefined, true))
    const paused = await pauseAtSettlement(ctx)
    await ctx.admission.setSchedulerMode('enabled')
    setFixturePresetContent(ctx, 'changed controlled composition')

    await expect(ctx.dispatch.resumeRun(paused.runId)).rejects.toThrow(/composition changed or is unavailable/i)

    expect(ctx.admission.snapshot().runs.find((run) => run.runId === paused.runId)).toMatchObject({
      state: 'paused',
      execution: { recovery: { reason: 'composition-unavailable' } },
    })
  })

  it('turns cancellation of a resumed root into a durable operator pause before draining it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-dispatch-resume-cancel-'))
    temporaryDirectories.push(root)
    const adapter = new ControlledAdapter('verified', 'known', 'valid', undefined, true)
    const ctx = await bootFixture(root, adapter)
    const paused = await pauseAtSettlement(ctx)
    await ctx.admission.setSchedulerMode('enabled')
    const resumedRequestStarted = new Deferred<void>()
    const releaseRequest = new Deferred<void>()
    adapter.beforeResponse = async (response) => {
      if (response !== 3) return
      resumedRequestStarted.resolve()
      await releaseRequest.promise
    }
    const controller = new AbortController()

    const resuming = ctx.dispatch.resumeRun(paused.runId, controller.signal)
    await resumedRequestStarted.promise
    controller.abort(new Error('command owner withdrawn'))
    await expect.poll(() => ctx.admission.snapshot().runs[0]?.state).toBe('pausing')
    releaseRequest.resolve()

    await expect(resuming).resolves.toMatchObject({
      runId: paused.runId,
      state: 'paused',
      pause: { reason: 'operator', operatorHold: true, lastCompletedPhase: 'agent-quiescent' },
    })
    expect(ctx.agents.roots()).toEqual([])
  })

  it('fences new dispatch while an allocated run still requires restart recovery', async () => {
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

    await expect(ctx.dispatch.dispatchNext()).rejects.toThrow(/recovery.*before execution/i)

    expect(ctx.admission.snapshot().runs.find((run) => run.displayKey === 'FIX-RECOVERY-NEW')).toMatchObject({
      state: 'queued',
    })
    expect(ctx.admission.snapshot().runs.find((run) => run.runId === paused.runId)).toMatchObject({
      state: 'paused',
      execution: { recovery: { reason: 'session-unavailable' } },
    })
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
    await resumed.plugin(AutopilotConfig)
    await resumed.plugin(RuntimeOwner, { authoritativeStorePath: join(root, 'state.sqlite') })
    await resumed.plugin(Admission)
    await resumed.plugin(PullRequestDispositionRegistry)
    await resumed.plugin(AutopilotOperations)
    await mountExecutionLifecycle(resumed)
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
})
