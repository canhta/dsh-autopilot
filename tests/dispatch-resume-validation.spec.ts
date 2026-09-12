import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bootFixture, ControlledAdapter, pauseAtSettlement, temporaryDirectories } from './dispatch-fixtures.js'

describe('durable resume resource validation', () => {
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

    const after = ctx.admission.snapshot()
    expect(after.revision).toBeGreaterThan(before.revision)
    expect(after).toMatchObject({
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

    const after = ctx.admission.snapshot()
    expect(after.revision).toBeGreaterThan(before.revision)
    expect(after).toMatchObject({
      runs: [{ runId: paused.runId, state: 'paused', execution: { recovery: { reason: 'session-unavailable' } } }],
    })
    expect(ctx.agents.roots()).toEqual([])
  })

  it('leaves an allocated pause unchanged when durable workspace ownership is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-dispatch-workspace-owner-'))
    temporaryDirectories.push(root)
    const adapter = new ControlledAdapter()
    const ctx = await bootFixture(root, adapter)
    const paused = await pauseAtSettlement(ctx)
    await ctx.admission.setSchedulerMode('enabled')
    const before = ctx.admission.snapshot()
    ctx.workspaceRegistry.resolveByPath = () => Promise.resolve(undefined)

    await expect(ctx.dispatch.resumeRun(paused.runId)).rejects.toThrow(/workspace ownership.*recovery/i)

    const after = ctx.admission.snapshot()
    expect(after.revision).toBeGreaterThan(before.revision)
    expect(after).toMatchObject({
      runs: [{ runId: paused.runId, state: 'paused', execution: { recovery: { reason: 'workspace-unavailable' } } }],
    })
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

    const after = ctx.admission.snapshot()
    expect(after.revision).toBeGreaterThan(before.revision)
    expect(after).toMatchObject({
      runs: [{ runId: paused.runId, state: 'paused', execution: { recovery: { reason: 'worktree-mismatch' } } }],
    })
    expect(ctx.agents.roots()).toEqual([])
  })

  it('rejects a replacement repository even when branch, head, and status match the checkpoint', async () => {
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

    const after = ctx.admission.snapshot()
    expect(after.revision).toBeGreaterThan(before.revision)
    expect(after).toMatchObject({
      runs: [{ runId: paused.runId, state: 'paused', execution: { recovery: { reason: 'worktree-mismatch' } } }],
    })
    expect(ctx.agents.roots()).toEqual([])
  })

  it('disposes a resumed root when workspace attachment fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-dispatch-resume-attach-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter())
    const paused = await pauseAtSettlement(ctx)
    const workspace = await ctx.workspaceRegistry.resolveByPath(paused.execution.worktreePath)
    if (workspace === undefined) throw new Error('expected retained workspace')
    workspace.attachSession = () => Promise.reject(new Error('controlled workspace attachment failure'))
    await ctx.admission.setSchedulerMode('enabled')

    const failed = await ctx.dispatch.resumeRun(paused.runId)

    expect(failed).toMatchObject({ state: 'failed', outcome: { kind: 'failed' } })
    expect(ctx.agents.roots()).toEqual([])
  })
})
