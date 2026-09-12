import { type Context, Service } from '@deepseek-ai/cordis'
import type { RunId, TerminalRun } from '../admission.js'
import { CodeHostProviderError, type CodeHostPublisher, type PullRequestReceipt } from '../code-host.js'
import { preparePublication } from './git.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    publication: Publication
  }
}

/** Sole Host owner of recoverable branch and ready-for-review pull-request publication. */
export class Publication extends Service {
  static readonly inject = ['admission', 'codeHost', 'subprocess']
  private readonly active = new Map<RunId, Promise<TerminalRun>>()
  private readonly controller = new AbortController()
  private accepting = false
  private generation = 0

  constructor(ctx: Context) {
    super(ctx, 'publication')
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    this.accepting = true
    this.generation += 1
    yield async () => {
      this.accepting = false
      this.generation += 1
      this.controller.abort(new Error('publication owner was disposed'))
      await Promise.allSettled(this.active.values())
    }
  }

  /**
   * Claim and reconcile one persisted verified intent, revalidate local Git, and create at most one deterministic branch
   * and ready PR. Ambiguous writes remain `publishing/uncertain`; bounded definite failures end the run as `failed`.
   */
  publish(runId: RunId, callerSignal?: AbortSignal): Promise<TerminalRun> {
    this.assertAccepting()
    const current = this.active.get(runId)
    if (current !== undefined) return current
    const generation = this.generation
    const signal =
      callerSignal === undefined ? this.controller.signal : AbortSignal.any([this.controller.signal, callerSignal])
    const operation = this.publishOwned(runId, generation, signal).finally(() => this.active.delete(runId))
    this.active.set(runId, operation)
    return operation
  }

  private async publishOwned(runId: RunId, generation: number, signal: AbortSignal): Promise<TerminalRun> {
    const { run, owner } = await this.ctx.admission.claimPublication(runId)
    try {
      this.assertGeneration(generation, signal)
      const publication = await preparePublication(this.ctx.subprocess, run, signal)
      this.assertGeneration(generation, signal)
      return await this.ctx.codeHost.withProvider(
        run.publication?.providerId ?? publicationProviderMissing(),
        (provider) => this.reconcileAndPublish(runId, owner, provider, publication, generation, signal),
      )
    } catch (error) {
      const failure = classifyFailure(error, signal.aborted || generation !== this.generation)
      try {
        return await this.ctx.admission.failPublication(runId, owner, error, failure.status, failure.retryAfterMs)
      } catch (commitError) {
        throw new AggregateError(
          [error, commitError],
          'publication failed and its durable outcome could not be recorded',
        )
      }
    }
  }

  private async reconcileAndPublish(
    runId: RunId,
    owner: string,
    provider: CodeHostPublisher,
    publication: Awaited<ReturnType<typeof preparePublication>>,
    generation: number,
    signal: AbortSignal,
  ): Promise<TerminalRun> {
    let observed = await provider.reconcile(publication, signal)
    this.assertGeneration(generation, signal)
    assertBaseAndConflict(publication.baseHead, observed)
    if (observed.pullRequest.kind === 'matching') {
      assertReadyReceipt(observed.pullRequest.receipt, publication, observed)
      this.assertGeneration(generation, signal)
      await this.ctx.admission.recordPublicationBranch(runId, owner, observed.pullRequest.receipt.remoteHead)
      return await this.ctx.admission.completePublication(runId, owner, observed.pullRequest.receipt)
    }

    if (observed.branch.kind === 'missing') {
      this.ctx.admission.assertPublicationOwner(runId, owner)
      this.assertGeneration(generation, signal)
      await provider.createBranch(publication, signal)
      this.assertGeneration(generation, signal)
      observed = await provider.reconcile(publication, signal)
      this.assertGeneration(generation, signal)
      assertBaseAndConflict(publication.baseHead, observed)
    }
    if (observed.branch.kind === 'base') {
      this.ctx.admission.assertPublicationOwner(runId, owner)
      this.assertGeneration(generation, signal)
      await provider.publishChanges(publication, signal)
      this.assertGeneration(generation, signal)
      observed = await provider.reconcile(publication, signal)
      this.assertGeneration(generation, signal)
      assertBaseAndConflict(publication.baseHead, observed)
    }
    if (observed.branch.kind !== 'published') {
      throw new CodeHostProviderError('conflict', 'code-host branch did not reconcile to the verified tree')
    }
    this.assertGeneration(generation, signal)
    await this.ctx.admission.recordPublicationBranch(runId, owner, observed.branch.remoteHead)

    if (observed.pullRequest.kind === 'missing') {
      this.ctx.admission.assertPublicationOwner(runId, owner)
      this.assertGeneration(generation, signal)
      const receipt = await provider.createPullRequest(publication, signal)
      try {
        this.assertGeneration(generation, signal)
        assertReadyReceipt(receipt, publication, observed)
        observed = await provider.reconcile(publication, signal)
        this.assertGeneration(generation, signal)
        assertBaseAndConflict(publication.baseHead, observed)
        if (observed.pullRequest.kind !== 'matching') {
          throw new CodeHostProviderError(
            'conflict',
            'code-host pull request could not be reconciled by deterministic identity',
          )
        }
        assertReadyReceipt(observed.pullRequest.receipt, publication, observed)
        this.assertGeneration(generation, signal)
        return await this.ctx.admission.completePublication(runId, owner, observed.pullRequest.receipt)
      } catch {
        throw new CodeHostProviderError(
          'ambiguous-acknowledgement',
          'pull-request creation succeeded but its durable identity could not be confirmed',
        )
      }
    }
    if (observed.pullRequest.kind !== 'matching') {
      throw new CodeHostProviderError(
        'conflict',
        'code-host pull request could not be reconciled by deterministic identity',
      )
    }
    assertReadyReceipt(observed.pullRequest.receipt, publication, observed)
    this.assertGeneration(generation, signal)
    return await this.ctx.admission.completePublication(runId, owner, observed.pullRequest.receipt)
  }

  private assertAccepting(): void {
    if (!this.accepting) throw new Error('publication is unavailable while its required services are changing')
  }

  private assertGeneration(generation: number, signal: AbortSignal): void {
    signal.throwIfAborted()
    if (!this.accepting || generation !== this.generation) throw new Error('publication owner generation was retired')
  }
}

function assertBaseAndConflict(
  expectedBase: string,
  observed: Awaited<ReturnType<CodeHostPublisher['reconcile']>>,
): void {
  if (observed.baseHead !== expectedBase)
    throw new CodeHostProviderError('conflict', 'remote base changed after verification')
  if (observed.branch.kind === 'conflict')
    throw new CodeHostProviderError('conflict', 'deterministic branch is unrelated')
  if (observed.pullRequest.kind === 'conflict') {
    throw new CodeHostProviderError('conflict', 'deterministic pull-request identity is unrelated or closed')
  }
}

function assertReadyReceipt(
  receipt: PullRequestReceipt,
  publication: Awaited<ReturnType<typeof preparePublication>>,
  observed: Awaited<ReturnType<CodeHostPublisher['reconcile']>>,
): void {
  const remoteHead = observed.branch.kind === 'missing' ? undefined : observed.branch.remoteHead
  if (
    receipt.state !== 'open' ||
    receipt.baseBranch !== publication.baseBranch ||
    receipt.headBranch !== publication.headBranch ||
    remoteHead === undefined ||
    receipt.remoteHead !== remoteHead
  ) {
    throw new CodeHostProviderError('conflict', 'pull request is not a ready open handoff for the published branch')
  }
}

function classifyFailure(
  error: unknown,
  ownerRetired: boolean,
): { status: 'uncertain' | 'retryable-failure' | 'failed'; retryAfterMs?: number } {
  if (ownerRetired) return { status: 'uncertain' }
  if (error instanceof CodeHostProviderError) {
    if (['ambiguous-acknowledgement', 'timeout'].includes(error.code)) return { status: 'uncertain' }
    if (['rate-limit', 'transient', 'provider-unavailable'].includes(error.code)) {
      return {
        status: 'retryable-failure',
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      }
    }
  }
  return { status: 'failed' }
}

function publicationProviderMissing(): never {
  throw new Error('publication intent has no provider identity')
}

export default Publication
