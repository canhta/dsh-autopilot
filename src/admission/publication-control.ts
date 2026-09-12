import type { PullRequestReceipt } from '../code-host.js'
import { MAX_AUTOMATIC_EXTERNAL_ATTEMPTS, STATE_KEY } from './constants.js'
import { appendLifecycleDeliveries, sanitizeDeliveryError } from './deliveries.js'
import type { RunId, TerminalRun } from './model.js'
import { boundedExternalRetry } from './policy.js'
import type { AdmissionDependencies } from './ports.js'
import { runIdSchema, stateSchema } from './state.js'

export class PublicationControl {
  constructor(private readonly dependencies: AdmissionDependencies) {}

  async claim(runId: RunId): Promise<{ run: TerminalRun; owner: string }> {
    const parsedRunId = runIdSchema.parse(runId)
    const owner = crypto.randomUUID()
    let claimed: TerminalRun | undefined
    await this.dependencies.table().update(STATE_KEY, (current) => {
      const index = current.runs.findIndex((run) => run.runId === parsedRunId)
      const run = current.runs[index]
      if (run?.state !== 'publishing' || run.publication === undefined) {
        throw new Error(`run "${parsedRunId}" is not awaiting publication`)
      }
      if (['failed', 'exhausted', 'succeeded'].includes(run.publication.status)) {
        throw new Error(`run "${parsedRunId}" publication is not automatically retryable`)
      }
      if (run.publication.status === 'in-flight')
        throw new Error(`run "${parsedRunId}" publication already has an owner`)
      if (run.publication.nextRetryAt !== undefined && Date.parse(run.publication.nextRetryAt) > Date.now()) {
        throw new Error(`run "${parsedRunId}" publication retry is not due`)
      }
      const next = structuredClone(current)
      claimed = {
        ...run,
        publication: {
          ...run.publication,
          revision: run.publication.revision + 1,
          status: 'in-flight',
          attempts: run.publication.attempts + 1,
          owner,
          nextRetryAt: undefined,
          exhaustedFrom: undefined,
          lastError: undefined,
        },
      }
      next.runs[index] = claimed
      next.revision += 1
      return stateSchema.parse(next)
    })
    if (claimed === undefined) throw new Error(`run "${parsedRunId}" publication was not claimed`)
    return { run: structuredClone(claimed), owner }
  }

  assertOwner(runId: RunId, owner: string): void {
    const run = this.dependencies.state().runs.find((candidate) => candidate.runId === runId)
    if (run?.state !== 'publishing' || run.publication?.status !== 'in-flight' || run.publication.owner !== owner) {
      throw new Error(`run "${runId}" publication owner is retired`)
    }
  }

  async recordBranch(runId: RunId, owner: string, remoteHead: string): Promise<TerminalRun> {
    return await this.updateOwned(runId, owner, (run) => ({
      ...run,
      publication: {
        ...requiredPublication(run),
        revision: requiredPublication(run).revision + 1,
        branchReceipt: { remoteHead, receivedAt: new Date().toISOString() },
      },
    }))
  }

  async complete(runId: RunId, owner: string, receipt: PullRequestReceipt): Promise<TerminalRun> {
    return await this.updateOwned(runId, owner, (run, aggregateRevision) => {
      const completedAt = new Date().toISOString()
      const completed: TerminalRun = {
        ...run,
        state: 'completed',
        completedAt,
        publication: {
          ...requiredPublication(run),
          revision: requiredPublication(run).revision + 1,
          status: 'succeeded',
          owner: undefined,
          lastError: undefined,
          receipt: structuredClone(receipt),
        },
      }
      return {
        ...completed,
        deliveries: appendLifecycleDeliveries(
          completed,
          this.dependencies.settings(),
          'completed',
          aggregateRevision + 1,
          completedAt,
        ),
      }
    })
  }

  async fail(
    runId: RunId,
    owner: string,
    error: unknown,
    status: 'uncertain' | 'retryable-failure' | 'failed',
    retryAfterMs?: number,
  ): Promise<TerminalRun> {
    return await this.updateOwned(runId, owner, (run, aggregateRevision) => {
      const publication = requiredPublication(run)
      const exhausted = status !== 'failed' && publication.attempts >= MAX_AUTOMATIC_EXTERNAL_ATTEMPTS
      const nextStatus = exhausted ? 'exhausted' : status
      const lastError = sanitizeDeliveryError(error)
      const failedPublication = {
        ...publication,
        revision: publication.revision + 1,
        status: nextStatus,
        owner: undefined,
        nextRetryAt:
          !exhausted && status === 'retryable-failure'
            ? new Date(Date.now() + boundedExternalRetry(retryAfterMs, publication.attempts)).toISOString()
            : undefined,
        exhaustedFrom: exhausted ? status : undefined,
        lastError,
      } as const
      if (nextStatus !== 'failed' && nextStatus !== 'exhausted') {
        return {
          ...run,
          publication: failedPublication,
        }
      }
      const failedAt = new Date().toISOString()
      const failed: TerminalRun = {
        ...run,
        state: 'failed',
        completedAt: failedAt,
        outcome: {
          kind: 'failed',
          summary: 'Pull-request publication could not be completed.',
          evidence: [...run.outcome.evidence.slice(0, 99), lastError],
        },
        publication: failedPublication,
      }
      return {
        ...failed,
        deliveries: appendLifecycleDeliveries(
          failed,
          this.dependencies.settings(),
          'failed',
          aggregateRevision + 1,
          failedAt,
        ),
      }
    })
  }

  private async updateOwned(
    runId: RunId,
    owner: string,
    mutate: (run: TerminalRun, aggregateRevision: number) => TerminalRun,
  ): Promise<TerminalRun> {
    let updated: TerminalRun | undefined
    await this.dependencies.table().update(STATE_KEY, (current) => {
      const next = structuredClone(current)
      const index = next.runs.findIndex((run) => run.runId === runId)
      const run = next.runs[index]
      if (run?.state !== 'publishing' || run.publication?.status !== 'in-flight' || run.publication.owner !== owner) {
        throw new Error(`run "${runId}" publication owner is retired`)
      }
      updated = mutate(run, current.revision)
      next.runs[index] = updated
      next.revision += 1
      return stateSchema.parse(next)
    })
    if (updated === undefined) throw new Error(`run "${runId}" publication update was not committed`)
    return structuredClone(updated)
  }
}

function requiredPublication(run: TerminalRun) {
  if (run.publication === undefined) throw new Error(`run "${run.runId}" has no publication intent`)
  return run.publication
}
