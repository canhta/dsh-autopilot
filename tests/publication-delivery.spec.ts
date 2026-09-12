import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodeHostProviderError } from '../src/code-host.js'
import { NotificationProviderError } from '../src/notification.js'
import {
  createFixtureCodeHostProvider,
  createFixtureNotificationProvider,
  type FixtureCodeHostState,
} from '../src/testing.js'
import { readinessGeneration } from '../src/tracker.js'
import { summaryOf } from '../src/web/projection.js'
import { AutopilotWebContributions, AutopilotWebIntegrations } from '../src/web.js'
import {
  bootFixture,
  ControlledAdapter,
  candidate,
  deliveryFiber,
  publicationFiber,
  remountAdmission,
  temporaryDirectories,
} from './dispatch-fixtures.js'
import { Deferred, fixtureCompositionClaim } from './dsh-fixtures.js'

describe('durable publication and outbound delivery', () => {
  it.each(['authentication', 'permission', 'not-found'] as const)(
    'keeps a created PR uncertain when %s blocks confirmation',
    async (code) => {
      const root = await mkdtemp(join(tmpdir(), `dsh-autopilot-post-create-${code}-`))
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
          await writeFile(join(worktree, 'published.txt'), 'post-create uncertainty\n')
          execFileSync('git', ['add', 'published.txt'], { cwd: worktree })
          execFileSync('git', ['commit', '-m', 'exercise post-create uncertainty'], { cwd: worktree })
        },
        false,
        undefined,
        () => ({
          head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim(),
          status: execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' }),
        }),
      )
      const ctx = await bootFixture(root, adapter)
      const baseHead = execFileSync('git', ['rev-parse', 'main'], {
        cwd: join(root, 'target'),
        encoding: 'utf8',
      }).trim()
      const state: FixtureCodeHostState = { baseHead }
      const base = createFixtureCodeHostProvider({ state })
      let created = false
      ctx.codeHost.register({
        ...base,
        reconcile(request) {
          if (created) throw new CodeHostProviderError(code, `fixture ${code} after PR creation`)
          return base.reconcile(request)
        },
        async createPullRequest(request) {
          const receipt = await base.createPullRequest(request)
          created = true
          return receipt
        },
      })
      const publishing = await ctx.dispatch.dispatchNext()
      if (publishing?.state !== 'publishing') throw new Error('fixture did not reach durable publication')

      await expect(ctx.publication.publish(publishing.runId)).resolves.toMatchObject({
        state: 'publishing',
        publication: { status: 'uncertain', attempts: 1 },
      })
      expect(state.pullRequest).toBeDefined()
    },
  )

  it('reconciles an ambiguous PR acknowledgement without creating duplicate code-host or tracker effects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-publication-'))
    temporaryDirectories.push(root)
    const worktreeRoot = join(root, 'worktrees')
    let worktree = ''
    const readGit = () => ({
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim(),
      status: execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' }),
    })
    const adapter = new ControlledAdapter(
      'verified',
      'known',
      'valid',
      async () => {
        const entries = await readdir(worktreeRoot)
        if (entries.length !== 1 || entries[0] === undefined) throw new Error('fixture worktree was not allocated')
        worktree = join(worktreeRoot, entries[0])
        await writeFile(join(worktree, 'published.txt'), 'durable publication\n')
        execFileSync('git', ['add', 'published.txt'], { cwd: worktree })
        execFileSync('git', ['commit', '-m', 'publish fixture'], { cwd: worktree })
      },
      false,
      undefined,
      readGit,
    )
    const ctx = await bootFixture(root, adapter, undefined, {
      notificationSubscriptions: ['success', 'retry', 'permanent', 'ambiguous'].map((destinationId) => ({
        providerId: 'fixture-notification',
        destinationId,
        events: ['completed'],
      })),
    })
    const baseHead = execFileSync('git', ['rev-parse', 'main'], {
      cwd: join(root, 'target'),
      encoding: 'utf8',
    }).trim()
    const codeHostState: FixtureCodeHostState = { baseHead }
    const baseProvider = createFixtureCodeHostProvider({ state: codeHostState })
    let pullRequestAttempts = 0
    ctx.codeHost.register({
      ...baseProvider,
      async createPullRequest(request) {
        pullRequestAttempts += 1
        const receipt = await baseProvider.createPullRequest(request)
        if (pullRequestAttempts === 1) {
          throw new CodeHostProviderError('ambiguous-acknowledgement', 'fixture lost the create acknowledgement')
        }
        return receipt
      },
    })
    const notificationState = { events: new Map() }
    const baseNotifications = createFixtureNotificationProvider(notificationState)
    let retryAttempts = 0
    ctx.notifications.register({
      ...baseNotifications,
      deliver(request) {
        if (request.destinationId === 'retry' && retryAttempts++ === 0) {
          throw new NotificationProviderError('transient', 'fixture notification is temporarily unavailable')
        }
        if (request.destinationId === 'permanent') {
          throw new NotificationProviderError('permanent-rejection', 'fixture destination rejected the event')
        }
        if (request.destinationId === 'ambiguous') {
          throw new NotificationProviderError('ambiguous-acknowledgement', 'fixture acknowledgement was lost')
        }
        return baseNotifications.deliver(request)
      },
    })
    const publishing = await ctx.dispatch.dispatchNext()
    if (publishing?.state !== 'publishing') throw new Error('fixture did not reach durable publication')
    const first = await ctx.publication.publish(publishing.runId)

    expect(first).toMatchObject({
      state: 'publishing',
      publication: { status: 'uncertain', attempts: 1 },
    })
    expect(codeHostState.pullRequest).toBeDefined()
    expect(pullRequestAttempts).toBe(1)

    await remountAdmission(ctx)
    expect(ctx.admission.snapshot().runs[0]).toMatchObject({
      state: 'publishing',
      publication: { status: 'uncertain', attempts: 1 },
    })

    await expect.poll(() => ctx.get('dispatch')).toBeDefined()
    await expect(ctx.dispatch.dispatchNext()).rejects.toThrow(/recovery.*before execution/i)
    const completed = ctx.admission.snapshot().runs.find((run) => run.runId === publishing.runId)
    if (completed?.state !== 'completed') throw new Error('startup workflow did not recover publication')

    expect(completed).toMatchObject({
      state: 'completed',
      publication: {
        status: 'succeeded',
        attempts: 2,
        receipt: { number: 1, state: 'open', remoteHead: readGit().head },
      },
    })
    expect(pullRequestAttempts).toBe(1)

    let delivered = ctx.admission.snapshot().runs[0]?.deliveries ?? []
    expect(delivered.filter((delivery) => delivery.status === 'succeeded')).toHaveLength(4)
    expect(
      delivered.find((delivery) => delivery.kind === 'notification' && delivery.destinationId === 'retry'),
    ).toMatchObject({
      status: 'retryable-failure',
    })
    expect(
      delivered.find((delivery) => delivery.kind === 'notification' && delivery.destinationId === 'permanent'),
    ).toMatchObject({ status: 'permanent-failure' })
    expect(
      delivered.find((delivery) => delivery.kind === 'notification' && delivery.destinationId === 'ambiguous'),
    ).toMatchObject({ status: 'uncertain' })
    expect(notificationState.events).toHaveLength(1)

    await ctx.plugin(AutopilotWebContributions)
    await ctx.plugin(AutopilotWebIntegrations)
    const projected = summaryOf(
      completed,
      new Map([['fixture', 'Fixture tracker']]),
      true,
      ctx.autopilotWebContributions,
    )
    expect(projected).toMatchObject({
      lifecycle: 'completed',
      pullRequest: { status: 'available', url: 'https://code-host.example.invalid/pulls/1' },
      attention: true,
    })
    expect(projected.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'notification',
          destination: 'fixture-notification:permanent',
          status: 'permanent-failure',
        }),
      ]),
    )

    const retry = delivered.find((delivery) => delivery.kind === 'notification' && delivery.destinationId === 'retry')
    if (retry === undefined) throw new Error('retryable notification was not retained')
    await ctx.delivery.retry(retry.id)
    delivered = ctx.admission.snapshot().runs[0]?.deliveries ?? []
    expect(delivered.find((delivery) => delivery.id === retry.id)).toMatchObject({ status: 'succeeded', attempts: 2 })
    expect(notificationState.events).toHaveLength(2)
  })

  it('retires a failed mutable projection and atomically replaces only its current lifecycle semantic', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-projection-repair-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter('blocked'))
    const blocked = await ctx.dispatch.dispatchNext()
    if (blocked?.state !== 'blocked') throw new Error('fixture did not produce a blocked run')
    const failedProjection = blocked.deliveries.find(
      (delivery) => delivery.kind === 'tracker-projection' && delivery.payload.desiredState === 'blocked',
    )
    if (failedProjection?.kind !== 'tracker-projection') throw new Error('blocked projection was not persisted')
    const claim = await ctx.admission.claimDelivery(failedProjection.id)
    await ctx.admission.failDelivery(
      claim.runId,
      claim.delivery.id,
      claim.owner,
      new Error('configured label no longer exists'),
      'permanent-failure',
    )
    await expect(
      ctx.admission.succeedDelivery(claim.runId, claim.delivery.id, claim.owner, {
        receiptId: 'stale-worker',
        receivedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(/owner is retired/)

    const replacement = await ctx.admission.repairTrackerProjection(failedProjection.id)

    expect(replacement).toMatchObject({
      kind: 'tracker-projection',
      status: 'pending',
      attempts: 0,
      payload: { desiredState: 'blocked', issueId: failedProjection.payload.issueId },
    })
    expect(replacement.id).not.toBe(failedProjection.id)
    const retained = ctx.admission.snapshot().runs[0]?.deliveries ?? []
    expect(retained.find((delivery) => delivery.id === failedProjection.id)).toMatchObject({ status: 'retired' })
    await expect(ctx.admission.repairTrackerProjection(failedProjection.id)).rejects.toThrow(/not a settled failed/)
  })

  it('rejects workflow-file publication before the code-host provider sees a side effect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-workflow-policy-'))
    temporaryDirectories.push(root)
    const worktreeRoot = join(root, 'worktrees')
    let worktree = ''
    const readGit = () => ({
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim(),
      status: execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' }),
    })
    const adapter = new ControlledAdapter(
      'verified',
      'known',
      'valid',
      async () => {
        const entries = await readdir(worktreeRoot)
        if (entries.length !== 1 || entries[0] === undefined) throw new Error('fixture worktree was not allocated')
        worktree = join(worktreeRoot, entries[0])
        await mkdir(join(worktree, '.github', 'workflows'), { recursive: true })
        await writeFile(join(worktree, '.github', 'workflows', 'check.yml'), 'name: forbidden\n')
        execFileSync('git', ['add', '.github/workflows/check.yml'], { cwd: worktree })
        execFileSync('git', ['commit', '-m', 'change workflow'], { cwd: worktree })
      },
      false,
      undefined,
      readGit,
    )
    const ctx = await bootFixture(root, adapter)
    const baseHead = execFileSync('git', ['rev-parse', 'main'], {
      cwd: join(root, 'target'),
      encoding: 'utf8',
    }).trim()
    const codeHostState: FixtureCodeHostState = { baseHead }
    ctx.codeHost.register(createFixtureCodeHostProvider({ state: codeHostState }))
    const publishing = await ctx.dispatch.dispatchNext()
    if (publishing?.state !== 'publishing') throw new Error('fixture did not reach durable publication')

    const failed = await ctx.publication.publish(publishing.runId)

    expect(failed).toMatchObject({
      state: 'failed',
      outcome: { kind: 'failed', summary: expect.stringMatching(/publication/i) },
      publication: { status: 'failed', lastError: expect.stringMatching(/workflow-file/) },
    })
    expect(codeHostState).toEqual({ baseHead })

    await expect(ctx.dispatch.dispatchNext()).resolves.toBeUndefined()
    await expect(ctx.publication.publish(publishing.runId)).rejects.toThrow(/not awaiting publication/)
    expect(ctx.admission.snapshot().runs[0]).toMatchObject({
      state: 'failed',
      publication: { status: 'failed', attempts: 1 },
      deliveries: expect.arrayContaining([
        expect.objectContaining({ kind: 'tracker-projection', status: 'succeeded' }),
      ]),
    })
  })

  it('records provider-generation withdrawal as uncertainty and reconciles it without a duplicate notification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-notification-withdrawal-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter('blocked'), undefined, {
      notificationSubscriptions: [{ providerId: 'fixture-notification', destinationId: 'ops', events: ['blocked'] }],
    })
    const blocked = await ctx.dispatch.dispatchNext()
    const pending = blocked?.deliveries.find((delivery) => delivery.kind === 'notification')
    if (pending?.kind !== 'notification') throw new Error('fixture did not retain notification delivery')
    const state = { events: new Map() }
    const base = createFixtureNotificationProvider(state)
    const started = new Deferred<void>()
    const release = new Deferred<void>()
    let sends = 0
    const dispose = ctx.notifications.register({
      ...base,
      async deliver(request) {
        sends += 1
        const receipt = await base.deliver(request)
        started.resolve()
        await release.promise
        return receipt
      },
    })

    const active = ctx.delivery.deliver(pending.id)
    await started.promise
    const withdrawing = dispose()
    release.resolve()
    await withdrawing

    await expect(active).resolves.toMatchObject({ status: 'uncertain', attempts: 1 })
    ctx.notifications.register(base)
    await expect(ctx.delivery.deliver(pending.id)).resolves.toMatchObject({ status: 'succeeded', attempts: 2 })
    expect(sends).toBe(1)
    expect(state.events).toHaveLength(1)
  })

  it('exhausts bounded automatic delivery attempts and retains an explicit operator retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-delivery-exhaustion-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter('blocked'), undefined, {
      notificationSubscriptions: [{ providerId: 'fixture-notification', destinationId: 'ops', events: ['blocked'] }],
    })
    const blocked = await ctx.dispatch.dispatchNext()
    const pending = blocked?.deliveries.find((delivery) => delivery.kind === 'notification')
    if (pending?.kind !== 'notification') throw new Error('fixture did not retain notification delivery')
    let sends = 0
    const dispose = ctx.notifications.register({
      ...createFixtureNotificationProvider({ events: new Map() }),
      deliver() {
        sends += 1
        throw new NotificationProviderError('transient', 'fixture destination is unavailable')
      },
    })

    let failed = await ctx.delivery.deliver(pending.id)
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await ctx.admission.retryDelivery(pending.id)
      failed = await ctx.delivery.deliver(pending.id)
    }

    expect(failed).toMatchObject({ status: 'exhausted', attempts: 5, exhaustedFrom: 'retryable-failure' })
    await ctx.delivery.deliverPending()
    expect(sends).toBe(5)

    await remountAdmission(ctx)
    await expect.poll(() => ctx.get('delivery')).toBeDefined()
    expect(
      ctx.admission
        .snapshot()
        .runs.flatMap((run) => run.deliveries)
        .find((delivery) => delivery.id === pending.id),
    ).toMatchObject({ status: 'exhausted', attempts: 5, exhaustedFrom: 'retryable-failure' })

    await dispose()
    ctx.notifications.register(createFixtureNotificationProvider({ events: new Map() }))
    await expect(ctx.delivery.retry(pending.id)).resolves.toMatchObject({ status: 'succeeded', attempts: 6 })
  })

  it('redacts summaries by default and discloses them only to an explicitly authorized channel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-notification-disclosure-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter('blocked'), undefined, {
      notificationSubscriptions: [
        { providerId: 'fixture-notification', destinationId: 'redacted', events: ['blocked'] },
        {
          providerId: 'fixture-notification',
          destinationId: 'full',
          events: ['blocked'],
          summaryDisclosure: 'full',
        },
      ],
    })

    const blocked = await ctx.dispatch.dispatchNext()
    if (blocked?.state !== 'blocked') throw new Error('fixture did not produce a blocked run')
    const notifications = blocked.deliveries.filter(
      (delivery): delivery is Extract<(typeof blocked.deliveries)[number], { kind: 'notification' }> =>
        delivery.kind === 'notification',
    )

    expect(notifications.find((delivery) => delivery.destinationId === 'redacted')?.payload.summary).toBe(
      'FIX-7 blocked; open the validated run link for details.',
    )
    expect(notifications.find((delivery) => delivery.destinationId === 'full')?.payload.summary).toBe(
      blocked.outcome.summary,
    )
  })

  it('atomically retires an older issue projection before any provider call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-projection-supersession-'))
    temporaryDirectories.push(root)
    const issues = [candidate()]
    const ctx = await bootFixture(root, new ControlledAdapter('blocked'), issues)
    const first = await ctx.dispatch.dispatchNext()
    const obsolete = first?.deliveries.find(
      (delivery) => delivery.kind === 'tracker-projection' && delivery.payload.desiredState === 'blocked',
    )
    if (obsolete?.kind !== 'tracker-projection') throw new Error('fixture did not retain the old projection')
    const oldClaim = await ctx.admission.claimDelivery(obsolete.id)
    issues[0] = candidate({
      readiness: {
        kind: 'transition',
        generation: readinessGeneration('transition-newer'),
        actorId: 'person-1',
        actorKind: 'human',
        occurredAt: '2026-09-12T00:00:00.000Z',
      },
    })
    await ctx.admission.reconcile({ source: 'manual' })
    const newer = await ctx.admission.claimNext(fixtureCompositionClaim())
    if (newer === undefined) throw new Error('fixture did not claim the newer readiness generation')
    const current = ctx.admission
      .snapshot()
      .runs.flatMap((run) => run.deliveries)
      .find(
        (delivery) =>
          delivery.kind === 'tracker-projection' &&
          delivery.payload.readinessGeneration === newer.readinessGeneration &&
          delivery.payload.desiredState === 'implementing',
      )
    if (current?.kind !== 'tracker-projection') throw new Error('fixture did not retain the newer projection')

    await expect(ctx.admission.claimDelivery(current.id)).rejects.toThrow(/older issue projection to settle/)
    await ctx.admission.failDelivery(
      oldClaim.runId,
      oldClaim.delivery.id,
      oldClaim.owner,
      new Error('fixture lost the old acknowledgement'),
      'uncertain',
    )
    const currentClaim = await ctx.admission.claimDelivery(current.id)
    await expect(ctx.delivery.deliver(obsolete.id)).resolves.toMatchObject({ status: 'retired' })
    await ctx.admission.succeedDelivery(currentClaim.runId, current.id, currentClaim.owner, {
      receiptId: 'fixture:newer-projection',
      receivedAt: new Date().toISOString(),
    })

    const retained = ctx.admission.snapshot().runs.flatMap((run) => run.deliveries)
    expect(retained.find((delivery) => delivery.id === obsolete.id)).toMatchObject({ status: 'retired' })
    expect(retained.find((delivery) => delivery.id === current.id)).toMatchObject({ status: 'succeeded' })
  })

  it('cancels and drains an active publication while preserving durable acknowledgement uncertainty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-publication-cancel-'))
    temporaryDirectories.push(root)
    const worktreeRoot = join(root, 'worktrees')
    let worktree = ''
    const adapter = new ControlledAdapter(
      'verified',
      'known',
      'valid',
      async () => {
        const entry = (await readdir(worktreeRoot))[0]
        if (entry === undefined) throw new Error('fixture worktree was not allocated')
        worktree = join(worktreeRoot, entry)
        await writeFile(join(worktree, 'cancel.txt'), 'cancel publication\n')
        execFileSync('git', ['add', 'cancel.txt'], { cwd: worktree })
        execFileSync('git', ['commit', '-m', 'prepare cancellation'], { cwd: worktree })
      },
      false,
      undefined,
      () => ({
        head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim(),
        status: execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' }),
      }),
    )
    const ctx = await bootFixture(root, adapter)
    const baseHead = execFileSync('git', ['rev-parse', 'main'], {
      cwd: join(root, 'target'),
      encoding: 'utf8',
    }).trim()
    const started = new Deferred<void>()
    ctx.codeHost.register({
      ...createFixtureCodeHostProvider({ state: { baseHead } }),
      reconcile: ({ signal }) =>
        new Promise((_, reject) => {
          started.resolve()
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    })
    const ownerFiber = publicationFiber(ctx)
    const publishing = await ctx.dispatch.dispatchNext()
    if (publishing?.state !== 'publishing') throw new Error('fixture did not reach publication')

    const active = ctx.publication.publish(publishing.runId)
    await started.promise
    await ownerFiber.dispose()

    await expect(active).resolves.toMatchObject({
      state: 'publishing',
      publication: { status: 'uncertain', owner: undefined },
    })
  })

  it('cancels and drains active delivery while preserving its durable acknowledgement uncertainty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-delivery-cancel-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter('blocked'), undefined, {
      notificationSubscriptions: [{ providerId: 'fixture-notification', destinationId: 'ops', events: ['blocked'] }],
    })
    const blocked = await ctx.dispatch.dispatchNext()
    const pending = blocked?.deliveries.find((delivery) => delivery.kind === 'notification')
    if (pending?.kind !== 'notification') throw new Error('fixture did not retain notification delivery')
    const started = new Deferred<void>()
    ctx.notifications.register({
      ...createFixtureNotificationProvider({ events: new Map() }),
      reconcile: ({ signal }) =>
        new Promise((_, reject) => {
          started.resolve()
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    })
    const ownerFiber = deliveryFiber(ctx)

    const active = ctx.delivery.deliver(pending.id)
    await started.promise
    await ownerFiber.dispose()

    await expect(active).resolves.toMatchObject({ status: 'uncertain', owner: undefined })
  })
})
