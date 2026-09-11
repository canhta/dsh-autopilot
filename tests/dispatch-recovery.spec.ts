import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Admission } from '../src/admission.js'
import { AutopilotConfig } from '../src/config.js'
import { Dispatch, FIXTURE_PROVIDER } from '../src/dispatch.js'
import { createFixtureTrackerProvider } from '../src/testing.js'
import { readinessGeneration, Tracker, trackerBindingId, trackerIssueId } from '../src/tracker.js'
import {
  bootFixture,
  ControlledAdapter,
  candidate,
  contexts,
  pauseAtSettlement,
  temporaryDirectories,
} from './dispatch-fixtures.js'
import { disposeContext, fixtureExecutionSettings, mountExecutionHostServices } from './dsh-fixtures.js'

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
    await resumed.plugin(AutopilotConfig)
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
})
