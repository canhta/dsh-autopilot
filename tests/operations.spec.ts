import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { Admission, type AutopilotRun } from '../src/admission.js'
import { CODE_HOST_INTERFACE_VERSION, codeHostProviderId, pullRequestId } from '../src/code-host.js'
import { AutopilotConfig } from '../src/config.js'
import { AutopilotOperations, PullRequestDispositionRegistry, RuntimeOwner } from '../src/operations.js'
import { Tracker } from '../src/tracker.js'
import { AutopilotCommands } from '../src/web/commands.js'
import { AutopilotWebContributions, AutopilotWebIntegrations } from '../src/web.js'
import {
  bootFixture,
  ControlledAdapter,
  contexts,
  pauseAtSettlement,
  temporaryDirectories,
} from './dispatch-fixtures.js'
import { Deferred, disposeContext, fixtureExecutionSettings, mountExecutionHostServices } from './dsh-fixtures.js'

/** `git worktree list` always prints forward-slash paths, even on Windows; normalize before comparing. */
function gitPath(path: string): string {
  return path.replaceAll('\\', '/')
}

async function completedFixture(prefix: string, options: { now?: () => number } = {}) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(root)
  let worktree = ''
  const adapter = new ControlledAdapter(
    'verified',
    'known',
    'valid',
    async () => {
      const entry = (await readdir(join(root, 'worktrees')))[0]
      if (entry === undefined) throw new Error('fixture worktree was not allocated')
      worktree = join(root, 'worktrees', entry)
      await writeFile(join(worktree, 'completed.txt'), 'verified cleanup fixture\n')
      execFileSync('git', ['add', 'completed.txt'], { cwd: worktree })
      execFileSync('git', ['commit', '-m', 'complete cleanup fixture'], { cwd: worktree })
    },
    false,
    undefined,
    () => ({
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim(),
      status: execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' }),
    }),
  )
  const ctx = await bootFixture(root, adapter, undefined, {}, options)
  const run = await ctx.dispatch.dispatchNext()
  if (run === undefined || run.state !== 'publishing' || run.execution.git === undefined) {
    throw new Error(`expected a completed fixture run with Git evidence: ${JSON.stringify(run)}`)
  }
  return { root, ctx, run }
}

function disposition(
  ctx: Awaited<ReturnType<typeof bootFixture>>,
  inspect: (
    run: AutopilotRun,
  ) => Promise<
    | { state: 'open'; head: string }
    | { state: 'merged'; head: string; mergedAt?: string }
    | { state: 'closed-unmerged'; head?: string }
    | { state: 'unknown'; reason: string }
  >,
) {
  return ctx.codeHost.register({
    id: codeHostProviderId('fixture-code-host'),
    interfaceVersion: CODE_HOST_INTERFACE_VERSION,
    displayName: 'Controlled cleanup code host',
    configurationNamespace: 'fixture-code-host',
    capabilities: ['repository', 'branch', 'pull-request', 'reconciliation'],
    async reconcile({ publication }) {
      const run = ctx.admission.snapshot().runs[0]
      if (run === undefined) throw new Error('cleanup fixture run is unavailable')
      const observed = await inspect(run)
      if (observed.state === 'unknown') throw new Error(observed.reason)
      const head = observed.head ?? publication.localHead
      return {
        baseHead: publication.baseHead,
        branch: { kind: 'published', remoteHead: head },
        pullRequest: {
          kind: 'matching',
          receipt: {
            id: pullRequestId('fixture-cleanup-pr'),
            number: 1,
            url: 'https://code-host.example.invalid/pulls/1',
            state: observed.state,
            baseBranch: publication.baseBranch,
            headBranch: publication.headBranch,
            remoteHead: head,
          },
        },
      }
    },
    createBranch: () => Promise.reject(new Error('cleanup resolver is read-only')),
    publishChanges: () => Promise.reject(new Error('cleanup resolver is read-only')),
    createPullRequest: () => Promise.reject(new Error('cleanup resolver is read-only')),
  })
}

describe('retained worktree operations', () => {
  it('adds and withdraws cleanup resolvers when code-host Settings are configured after startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-disposition-late-config-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter('blocked'), [], {
      executionMode: 'disabled',
      codeHostProvider: '',
    })

    const providerId = '2.vendor_code-host:v1'
    expect(ctx.pullRequestDisposition.has(providerId)).toBe(false)
    await ctx.settings.update('dsh-autopilot', { codeHostProvider: providerId })
    expect(ctx.pullRequestDisposition.has(providerId)).toBe(true)
    await ctx.settings.update('dsh-autopilot', { codeHostProvider: '' })
    expect(ctx.pullRequestDisposition.has(providerId)).toBe(false)
  })

  it('uses the run-owned provider identity for cleanup after the configured provider changes', async () => {
    const { ctx, run } = await completedFixture('dsh-autopilot-disposition-provider-switch-', {
      now: () => Date.parse('2026-09-12T00:00:00.000Z'),
    })
    const head = run.execution.git?.head
    if (head === undefined) throw new Error('expected final Git head')
    let pullRequestState: 'open' | 'merged' = 'open'
    disposition(ctx, () =>
      Promise.resolve(
        pullRequestState === 'open'
          ? { state: 'open', head }
          : { state: 'merged', head, mergedAt: '2026-09-01T00:00:00.000Z' },
      ),
    )
    await ctx.publication.publish(run.runId)
    await ctx.delivery.deliverPending()
    pullRequestState = 'merged'
    await ctx.settings.update('dsh-autopilot', { codeHostProvider: 'replacement', cleanupRetentionDays: 0 })

    expect(ctx.pullRequestDisposition.has('fixture-code-host')).toBe(true)
    expect(ctx.pullRequestDisposition.has('replacement')).toBe(true)
    const preview = await ctx.autopilotOperations.previewCleanup(run.runId)
    expect(preview).toMatchObject({
      eligible: true,
      disposition: { state: 'merged', head },
    })
  })

  it('fences a late disposition result after its resolver generation is withdrawn', async () => {
    const { ctx, run } = await completedFixture('dsh-autopilot-disposition-withdrawal-')
    const late = new Deferred<{ state: 'unknown'; reason: string }>()
    const dispose = ctx.pullRequestDisposition.register('controlled-disposition', { inspect: () => late.promise })
    const reading = ctx.pullRequestDisposition.inspect('controlled-disposition', run)

    const retiring = dispose()
    late.resolve({ state: 'unknown', reason: 'late controlled result' })

    await expect(reading).rejects.toThrow(/withdrawn|changed during read/i)
    await expect(retiring).resolves.toBeUndefined()
  })

  it.each([
    { state: 'open' as const, rejection: 'pr-open' },
    { state: 'closed-unmerged' as const, rejection: 'pr-closed-unmerged' },
    { state: 'unknown' as const, rejection: 'pr-unknown' },
  ])('fails closed for a $state PR', async ({ state, rejection }) => {
    const { ctx, run } = await completedFixture(`dsh-autopilot-cleanup-${state}-`)
    const head = run.execution.git?.head
    if (head === undefined) throw new Error('expected final Git head')
    disposition(ctx, () =>
      Promise.resolve(
        state === 'unknown'
          ? { state, reason: 'controlled unavailable provider' }
          : state === 'open'
            ? { state, head }
            : { state, head },
      ),
    )

    const preview = await ctx.autopilotOperations.previewCleanup(run.runId)

    expect(preview.eligible).toBe(false)
    expect(preview.rejections).toContain(rejection)
    await expect(ctx.autopilotOperations.removeWorktree(preview.previewId)).rejects.toThrow(/cleanup rejected/i)
    expect(
      execFileSync('git', ['worktree', 'list'], { cwd: run.execution.targetRepository, encoding: 'utf8' }),
    ).toContain(gitPath(run.execution.worktreePath))
  })

  it('normalizes provider failures to an unknown PR disposition', async () => {
    const { ctx, run } = await completedFixture('dsh-autopilot-cleanup-provider-failure-')
    disposition(ctx, () => Promise.reject(new Error('controlled provider failure')))

    const preview = await ctx.autopilotOperations.previewCleanup(run.runId)

    expect(preview.disposition).toEqual({
      state: 'unknown',
      reason: expect.stringMatching(/failed reconcile/i),
    })
    expect(preview.rejections).toContain('pr-unknown')
  })

  it('rejects cleanup while verified work is still publishing', async () => {
    const { ctx, run } = await completedFixture('dsh-autopilot-cleanup-publishing-')
    const head = run.execution.git?.head
    if (head === undefined) throw new Error('expected final Git head')
    disposition(ctx, () => Promise.resolve({ state: 'merged', head, mergedAt: '2020-01-01T00:00:00.000Z' }))

    const preview = await ctx.autopilotOperations.previewCleanup(run.runId)

    expect(preview.eligible).toBe(false)
    expect(preview.rejections).toContain('run-publishing')
  })

  it('rejects dirty and untracked work plus commits absent from the PR head', async () => {
    const { ctx, run } = await completedFixture('dsh-autopilot-cleanup-local-work-')
    const prHead = run.execution.git?.head
    if (prHead === undefined) throw new Error('expected final Git head')
    await writeFile(join(run.execution.worktreePath, 'README.md'), 'changed\n')
    await writeFile(join(run.execution.worktreePath, 'UNTRACKED.md'), 'untracked\n')
    execFileSync('git', ['add', 'README.md'], { cwd: run.execution.worktreePath })
    execFileSync('git', ['commit', '-m', 'local-only'], { cwd: run.execution.worktreePath })
    await writeFile(join(run.execution.worktreePath, 'README.md'), 'dirty after local commit\n')
    disposition(ctx, () => Promise.resolve({ state: 'merged', head: prHead, mergedAt: '2020-01-01T00:00:00.000Z' }))

    const preview = await ctx.autopilotOperations.previewCleanup(run.runId)

    expect(preview).toMatchObject({
      eligible: false,
      dirtyFiles: ['README.md'],
      untrackedFiles: ['UNTRACKED.md'],
      unpushedCommits: 1,
    })
    expect(preview.rejections).toEqual(expect.arrayContaining(['dirty-files', 'untracked-files', 'unpushed-commits']))
  })

  it('rejects a replacement repository at the recorded managed path', async () => {
    const { ctx, run } = await completedFixture('dsh-autopilot-cleanup-replaced-')
    const head = run.execution.git?.head
    if (head === undefined) throw new Error('expected final Git head')
    execFileSync('git', ['worktree', 'remove', '--force', run.execution.worktreePath], {
      cwd: run.execution.targetRepository,
    })
    execFileSync(
      'git',
      ['clone', '--branch', run.execution.branch, run.execution.targetRepository, run.execution.worktreePath],
      { cwd: run.execution.targetRepository },
    )
    disposition(ctx, () => Promise.resolve({ state: 'merged', head, mergedAt: '2020-01-01T00:00:00.000Z' }))

    const preview = await ctx.autopilotOperations.previewCleanup(run.runId)

    expect(preview.eligible).toBe(false)
    expect(preview.rejections).toContain('ownership-unproven')
  })

  it('keeps unresolved publishing work during automatic retention', async () => {
    const { ctx, run } = await completedFixture('dsh-autopilot-cleanup-retention-pass-')
    const head = run.execution.git?.head
    if (head === undefined) throw new Error('expected final Git head')
    disposition(ctx, () => Promise.resolve({ state: 'merged', head, mergedAt: '2020-01-01T00:00:00.000Z' }))

    await expect(ctx.autopilotOperations.runRetentionMaintenance()).resolves.toEqual({
      inspected: 1,
      removed: 0,
      attention: 1,
    })
    expect(
      execFileSync('git', ['worktree', 'list'], { cwd: run.execution.targetRepository, encoding: 'utf8' }),
    ).toContain(gitPath(run.execution.worktreePath))
  })

  it('keeps inspection non-authorizing and rejects a stale explicit cleanup preview through the Web command owner', async () => {
    const { ctx, run } = await completedFixture('dsh-autopilot-web-cleanup-stale-')
    const head = run.execution.git?.head
    if (head === undefined) throw new Error('expected final Git head')
    let pullRequestState: 'open' | 'merged' = 'open'
    disposition(ctx, () =>
      Promise.resolve(
        pullRequestState === 'open'
          ? { state: 'open', head }
          : { state: 'merged', head, mergedAt: '2020-01-01T00:00:00.000Z' },
      ),
    )
    await ctx.publication.publish(run.runId)
    await ctx.delivery.deliverPending()
    pullRequestState = 'merged'
    await ctx.settings.update('dsh-autopilot', { cleanupRetentionDays: 0 })
    await ctx.plugin(AutopilotWebContributions)
    await ctx.plugin(AutopilotWebIntegrations)

    const inspection = await ctx.autopilotWebContributions.inspectWorktree(run.runId)
    if (inspection?.cleanup.status === 'available' && !inspection.cleanup.eligible) {
      throw new Error(`fixture cleanup was ineligible: ${inspection.cleanup.rejections.join(', ')}`)
    }
    expect(inspection).toMatchObject({ state: 'cleanup-eligible', cleanup: { eligible: true } })
    await expect(ctx.autopilotOperations.removeWorktree('11111111-1111-4111-8111-111111111111')).rejects.toThrow(
      /preview is missing/i,
    )

    const preview = await ctx.autopilotWebContributions.previewCleanup(run.runId)
    if (preview === undefined) throw new Error('expected an explicit cleanup preview')
    await ctx.admission.runOperations.mutate(run.runId, async () => undefined)
    const commands = new AutopilotCommands(ctx)
    commands.start()
    const requestId = '984d0051-cb13-41fa-b9fd-7152d30d9791'
    await commands.command({ requestId, kind: 'remove-worktree', previewId: preview.previewId })
    await expect.poll(() => commands.status(requestId)?.status).toBe('rejected')
    expect(commands.status(requestId)?.message).toMatch(/fresh cleanup preview/i)
    expect(
      execFileSync('git', ['worktree', 'list'], { cwd: run.execution.targetRepository, encoding: 'utf8' }),
    ).toContain(gitPath(run.execution.worktreePath))
    await commands.dispose()
  })

  it('reconciles a replayed cleanup command from its durable completed audit', async () => {
    const { ctx, run } = await completedFixture('dsh-autopilot-web-cleanup-replay-')
    const head = run.execution.git?.head
    if (head === undefined) throw new Error('expected final Git head')
    let pullRequestState: 'open' | 'merged' = 'open'
    disposition(ctx, () =>
      Promise.resolve(
        pullRequestState === 'open'
          ? { state: 'open', head }
          : { state: 'merged', head, mergedAt: '2020-01-01T00:00:00.000Z' },
      ),
    )
    await ctx.publication.publish(run.runId)
    await ctx.delivery.deliverPending()
    pullRequestState = 'merged'
    await ctx.settings.update('dsh-autopilot', { cleanupRetentionDays: 0 })
    const preview = await ctx.autopilotOperations.previewCleanup(run.runId)
    if (!preview.eligible) throw new Error(`fixture cleanup was ineligible: ${preview.rejections.join(', ')}`)
    const requestId = '13ddcbd5-361a-4b41-9bfd-019f9a466586'
    await ctx.admission.acceptOperatorCommand({ requestId, kind: 'remove-worktree', previewId: preview.previewId })
    await ctx.admission.updateOperatorCommand(requestId, { status: 'in-progress' })
    await ctx.autopilotOperations.removeWorktree(preview.previewId, requestId)

    const commands = new AutopilotCommands(ctx)
    commands.start()

    await expect.poll(() => commands.status(requestId)?.status).toBe('succeeded')
    expect(await ctx.autopilotOperations.cleanupCommandOutcome(requestId)).toBe('completed')
    expect((await ctx.autopilotOperations.inspectWorktrees()).audit).toContainEqual(
      expect.objectContaining({ kind: 'cleanup-removed', operationId: requestId, outcome: 'completed' }),
    )
    expect(
      execFileSync('git', ['worktree', 'list'], { cwd: run.execution.targetRepository, encoding: 'utf8' }),
    ).not.toContain(gitPath(run.execution.worktreePath))
    await commands.dispose()
  })

  it('reconciles a persisted cleanup intent when removal succeeded before its acknowledgement', async () => {
    const { root, ctx, run } = await completedFixture('dsh-autopilot-cleanup-recovery-')
    contexts.splice(contexts.indexOf(ctx), 1)
    await disposeContext(ctx)
    withDatabase(join(root, 'state.sqlite'), (database) => {
      const row = database.prepare('SELECT value FROM u_autopilot_maintenance_state WHERE key = ?').get('primary') as {
        value: string
      }
      const state = JSON.parse(row.value) as Record<string, unknown>
      state.pendingCleanup = {
        operationId: '11111111-1111-4111-8111-111111111111',
        runId: run.runId,
        worktreePath: run.execution.worktreePath,
        previewFingerprint: 'a'.repeat(64),
        startedAt: '2026-09-12T00:00:00.000Z',
      }
      database
        .prepare('UPDATE u_autopilot_maintenance_state SET value = ? WHERE key = ?')
        .run(JSON.stringify(state), 'primary')
    })
    execFileSync('git', ['worktree', 'remove', run.execution.worktreePath], {
      cwd: run.execution.targetRepository,
    })

    const restarted = await mountExecutionHostServices(join(root, 'state.sqlite'), join(root, 'sessions'), {
      'dsh-autopilot': {
        trackerProvider: 'fixture',
        ...fixtureExecutionSettings(run.execution.targetRepository, join(root, 'worktrees')),
      },
    })
    contexts.push(restarted)
    await restarted.plugin(Tracker)
    await restarted.plugin(AutopilotConfig)
    await restarted.plugin(RuntimeOwner, { authoritativeStorePath: join(root, 'state.sqlite') })
    await restarted.plugin(Admission)
    await restarted.plugin(PullRequestDispositionRegistry)
    await restarted.plugin(AutopilotOperations)
    restarted.autopilotOperations.registerRecoveryParticipant('publication-delivery', {
      reconcile: () => Promise.resolve({ pending: 0 }),
    })
    await restarted.autopilotOperations.assertDispatchReady()

    expect(restarted.autopilotOperations.health()).toMatchObject({
      persistence: { status: 'ready' },
      recovery: { status: 'complete', pendingCleanup: false },
    })
    expect((await restarted.autopilotOperations.inspectWorktrees()).audit.at(-1)).toMatchObject({
      kind: 'cleanup-recovered',
      runId: run.runId,
      operationId: '11111111-1111-4111-8111-111111111111',
      outcome: 'completed',
    })
  })

  // Simulates the failure by writing a file where a directory is expected, then addressing a path
  // beneath it. POSIX fs.access() reports ENOTDIR for that; Windows reports ENOENT, which pathExists()
  // (by design) treats as ordinary absence instead of rethrowing, so the scenario this test exercises
  // cannot be reproduced there.
  it.skipIf(process.platform === 'win32')(
    'keeps a pending cleanup intent when path inspection fails for a reason other than absence',
    async () => {
      const { root, ctx, run } = await completedFixture('dsh-autopilot-cleanup-lookup-failure-')
      contexts.splice(contexts.indexOf(ctx), 1)
      await disposeContext(ctx)
      const nonDirectory = join(root, 'not-a-directory')
      await writeFile(nonDirectory, 'controlled lookup failure\n')
      const pendingPath = join(nonDirectory, 'worktree')
      withDatabase(join(root, 'state.sqlite'), (database) => {
        const row = database
          .prepare('SELECT value FROM u_autopilot_maintenance_state WHERE key = ?')
          .get('primary') as {
          value: string
        }
        const state = JSON.parse(row.value) as Record<string, unknown>
        state.pendingCleanup = {
          operationId: '22222222-2222-4222-8222-222222222222',
          runId: run.runId,
          worktreePath: pendingPath,
          previewFingerprint: 'b'.repeat(64),
          startedAt: '2026-09-12T00:00:00.000Z',
        }
        database
          .prepare('UPDATE u_autopilot_maintenance_state SET value = ? WHERE key = ?')
          .run(JSON.stringify(state), 'primary')
      })

      const restarted = await mountExecutionHostServices(join(root, 'state.sqlite'), join(root, 'sessions'), {
        'dsh-autopilot': {
          trackerProvider: 'fixture',
          ...fixtureExecutionSettings(run.execution.targetRepository, join(root, 'worktrees')),
        },
      })
      contexts.push(restarted)
      await restarted.plugin(Tracker)
      await restarted.plugin(AutopilotConfig)
      await restarted.plugin(RuntimeOwner, { authoritativeStorePath: join(root, 'state.sqlite') })
      await restarted.plugin(Admission)
      await restarted.plugin(PullRequestDispositionRegistry)

      await expect(restarted.plugin(AutopilotOperations)).rejects.toMatchObject({ code: 'ENOTDIR' })
      withDatabase(join(root, 'state.sqlite'), (database) => {
        const row = database
          .prepare('SELECT value FROM u_autopilot_maintenance_state WHERE key = ?')
          .get('primary') as {
          value: string
        }
        const state = JSON.parse(row.value) as { pendingCleanup?: { worktreePath?: string } }
        expect(state.pendingCleanup?.worktreePath).toBe(pendingPath)
      })
    },
  )

  it('projects unowned registered worktrees as orphans requiring reconciliation', async () => {
    const { root, ctx, run } = await completedFixture('dsh-autopilot-cleanup-orphan-')
    const orphan = join(root, 'worktrees', 'orphan')
    execFileSync('git', ['worktree', 'add', '-b', 'synthetic-orphan', orphan, 'main'], {
      cwd: run.execution.targetRepository,
    })

    const projection = await ctx.autopilotOperations.inspectWorktrees()

    expect(projection.orphans).toContainEqual({
      path: await realpath(orphan),
      branch: 'synthetic-orphan',
      state: 'orphan-reconciliation-required',
    })
  })

  it('uses the injected clock for durable first observation and retention', async () => {
    const now = Date.parse('2026-09-12T06:00:00.000Z')
    const { ctx, run } = await completedFixture('dsh-autopilot-cleanup-observation-', { now: () => now })
    const head = run.execution.git?.head
    if (head === undefined) throw new Error('expected final Git head')
    disposition(ctx, () => Promise.resolve({ state: 'merged', head }))

    const preview = await ctx.autopilotOperations.previewCleanup(run.runId)

    expect(preview.eligible).toBe(false)
    expect(preview.rejections).toContain('retention-not-met')
    expect(preview.retentionReference).toBe('2026-09-12T06:00:00.000Z')
    expect(preview.retentionEligibleAt).toBe('2026-09-19T06:00:00.000Z')
  })

  it('rejects a merged worktree while its run is paused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-cleanup-paused-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter())
    const paused = await pauseAtSettlement(ctx)
    const head = paused.execution.git?.head
    if (head === undefined) throw new Error('expected paused Git checkpoint')
    disposition(ctx, () => Promise.resolve({ state: 'merged', head, mergedAt: '2020-01-01T00:00:00.000Z' }))

    const preview = await ctx.autopilotOperations.previewCleanup(paused.runId)

    expect(preview.eligible).toBe(false)
    expect(preview.rejections).toContain('run-paused')
  })
})

function withDatabase(path: string, operation: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(path)
  try {
    operation(database)
  } finally {
    database.close()
  }
}
