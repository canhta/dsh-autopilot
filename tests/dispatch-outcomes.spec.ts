import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { Admission } from '../src/admission.js'
import { AutopilotConfig } from '../src/config.js'
import { AutopilotOperations, PullRequestDispositionRegistry, RuntimeOwner } from '../src/operations.js'
import { createFixtureTrackerProvider } from '../src/testing.js'
import { Tracker } from '../src/tracker.js'
import {
  bootFixture,
  ControlledAdapter,
  contexts,
  createTargetRepository,
  restartCandidate,
  temporaryDirectories,
} from './dispatch-fixtures.js'
import {
  appliedFixturePermissions,
  FIXTURE_MODEL,
  FIXTURE_PRESET,
  FIXTURE_PROVIDER,
  fixtureCompositionClaim,
  fixtureExecutionSettings,
  mountExecutionHostServices,
  mountedFixturePresets,
  setFixtureAgentDefaults,
} from './dsh-fixtures.js'

describe('durable fixture dispatch: terminal outcomes', () => {
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
      execution: {
        agent: {
          presetId: FIXTURE_PRESET,
          presetFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          permission: {
            presetId: 'autopilot-unattended',
            sandbox: 'workspace-write',
            approval: 'never',
          },
          model: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
        },
        codeHost: {
          providerId: 'fixture-code-host',
          bindingId: 'fixture:code-host',
          repositoryId: 'fixture:repository',
          repository: 'fixture/repository',
        },
      },
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
    expect(mountedFixturePresets(ctx)).toEqual([FIXTURE_PRESET])
    expect(appliedFixturePermissions(ctx)).toEqual(['autopilot-unattended'])

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

  it('leaves the ticket queued when the selected DSH model cannot be resolved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-model-preflight-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter())
    setFixtureAgentDefaults(ctx, { provider: 'missing-provider', model: 'missing-model' })

    await expect(ctx.dispatch.dispatchNext()).rejects.toThrow(/composition is unavailable/i)

    expect(ctx.admission.snapshot().runs[0]).toMatchObject({ state: 'queued' })
    expect(await readdir(join(root, 'worktrees'))).toEqual([])
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

  it('keeps the tracker binding fenced while a terminal run has a permanently failed delivery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-permanent-delivery-fence-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter('failed'))
    const failed = await ctx.dispatch.dispatchNext()
    if (failed?.state !== 'failed') throw new Error('fixture did not produce a failed run')
    const permanent = failed.deliveries.find(
      (delivery) => delivery.kind === 'tracker-report' && delivery.status === 'pending',
    )
    if (permanent === undefined) throw new Error('fixture did not retain a tracker delivery')
    const claim = await ctx.admission.claimDelivery(permanent.id)
    await ctx.admission.failDelivery(
      claim.runId,
      claim.delivery.id,
      claim.owner,
      new Error('configured tracker target rejected the delivery'),
      'permanent-failure',
    )
    await ctx.delivery.deliverPending()

    await expect(ctx.settings.update('dsh-autopilot', { trackerProvider: 'replacement' })).rejects.toThrow(
      /unresolved delivery intent/i,
    )
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
        summary: 'The Agent reported Git facts that do not match the managed worktree.',
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
    await expect(ctx.admission.claimNext(fixtureCompositionClaim())).rejects.toThrow(/token usage is uncertain/)
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
    await expect(ctx.admission.claimNext(fixtureCompositionClaim())).rejects.toThrow(/token usage is uncertain/)
  })

  it('marks an abruptly interrupted run for explicit recovery without duplicating its worktree or Session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-restart-'))
    temporaryDirectories.push(root)
    const repository = await createTargetRepository(root)
    await mkdir(join(root, 'worktrees'))
    await mkdir(join(root, 'sessions'))
    // Spawn Node directly against vitest's JS entry point: the node_modules/.bin shim is a POSIX
    // shell script and isn't natively executable on Windows (ENOENT there instead of a real exit).
    const crash = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        'tests/fixtures/crash-dispatch.spec.ts',
        '--maxWorkers=1',
        '--pool=threads',
      ],
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
    await ctx.plugin(AutopilotConfig)
    await ctx.plugin(RuntimeOwner, { authoritativeStorePath: join(root, 'state.sqlite') })
    await ctx.plugin(Admission)
    await ctx.plugin(PullRequestDispositionRegistry)
    await ctx.plugin(AutopilotOperations)

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
    await expect(ctx.admission.claimNext(fixtureCompositionClaim())).resolves.toBeUndefined()
    expect(ctx.admission.snapshot().runs.filter((run) => run.displayKey === 'FIX-7-RESTART')).toHaveLength(1)
  })
})
