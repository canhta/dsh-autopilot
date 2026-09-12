import { z } from 'zod'
import { validateExecutionSettings } from '../config.js'
import { trackerProviderId } from '../tracker.js'
import { readEveryCandidate } from './candidates.js'
import { STATE_KEY } from './constants.js'
import type {
  ActiveRecoveryReason,
  ActiveResumeAuthorization,
  GitExecutionSnapshot,
  ImplementingRun,
  PausedActiveRun,
  QueuedRun,
  RunId,
} from './model.js'
import {
  evaluateIssue,
  isPausedActiveRun,
  isPausedQueuedRun,
  matchesRetainedIssue,
  sameRetainedRun,
  validateActiveResumeFacts,
} from './policy.js'
import type { AdmissionDependencies } from './ports.js'
import { executionSchema, runIdSchema, stateSchema } from './state.js'

export class ResumeControl {
  constructor(private readonly dependencies: AdmissionDependencies) {}

  /**
   * Revalidate an operator-held queued run against the current tracker issue and return it to the resumption queue.
   * Requires an enabled scheduler, certain deployment usage, the selected tracker provider, one currently eligible issue,
   * and an unchanged readiness generation and Agent Brief. Provider/read/validation failures or a concurrent durable
   * state change preserve the hold. Success clears only the hold, keeps the run identity, and allocates no Session or
   * worktree. Provider withdrawal owns cancellation of its read; callers cannot independently cancel this operation.
   */
  async resumeRun(runId: RunId): Promise<QueuedRun> {
    const parsedRunId = runIdSchema.parse(runId)
    const settings = this.dependencies.settings()
    const providerId = trackerProviderId(settings.trackerProvider)
    const beforeRead = this.dependencies.state()
    if (beforeRead.scheduler.mode !== 'enabled') {
      throw new Error('scheduler must be enabled to resume a run')
    }
    if (beforeRead.budget.usageUncertain) {
      throw new Error('deployment token usage is uncertain; reconcile it before resuming')
    }
    const retained = beforeRead.runs.find((run) => run.runId === parsedRunId)
    if (retained === undefined) throw new Error(`run "${parsedRunId}" does not exist`)
    if (!isPausedQueuedRun(retained) || !retained.pause.operatorHold) {
      throw new Error(`run "${parsedRunId}" is not paused on an operator hold`)
    }
    if (retained.providerId !== providerId) {
      throw new Error(`run "${parsedRunId}" cannot be resumed from tracker provider "${providerId}"`)
    }

    return this.dependencies.tracker.withProvider(providerId, async (reader) => {
      const candidates = await readEveryCandidate(reader, providerId)
      const matches = candidates.filter(
        (issue) => issue.bindingId === retained.bindingId && issue.issueId === retained.issueId,
      )
      if (matches.length !== 1) {
        throw new Error(`run "${parsedRunId}" cannot be resumed because its tracker issue is not uniquely current`)
      }
      const issue = matches[0]
      if (issue === undefined) throw new Error(`run "${parsedRunId}" cannot be resumed without its tracker issue`)
      const evaluation = evaluateIssue(issue, settings.maxBriefBytes)
      if ('reason' in evaluation) {
        throw new Error(`run "${parsedRunId}" cannot be resumed because tracker eligibility is ${evaluation.reason}`)
      }
      if (!matchesRetainedIssue(retained, providerId, evaluation)) {
        throw new Error(`run "${parsedRunId}" cannot be resumed because its tracker authorization changed`)
      }

      let resumed: QueuedRun | undefined
      await this.dependencies.table().update(STATE_KEY, (current) => {
        if (current.scheduler.mode !== 'enabled') {
          throw new Error('scheduler must be enabled to resume a run')
        }
        if (current.budget.usageUncertain) {
          throw new Error('deployment token usage is uncertain; reconcile it before resuming')
        }
        const currentSettings = this.dependencies.settings()
        if (trackerProviderId(currentSettings.trackerProvider) !== providerId) {
          throw new Error(`run "${parsedRunId}" cannot be resumed because the selected tracker provider changed`)
        }
        const currentEvaluation = evaluateIssue(issue, currentSettings.maxBriefBytes)
        if ('reason' in currentEvaluation) {
          throw new Error(
            `run "${parsedRunId}" cannot be resumed because current tracker eligibility is ${currentEvaluation.reason}`,
          )
        }
        const index = current.runs.findIndex((run) => run.runId === parsedRunId)
        const run = current.runs[index]
        if (!isPausedQueuedRun(run) || !run.pause.operatorHold) {
          throw new Error(`run "${parsedRunId}" is not paused on an operator hold`)
        }
        if (!sameRetainedRun(run, retained) || !matchesRetainedIssue(run, providerId, currentEvaluation)) {
          throw new Error(`run "${parsedRunId}" cannot be resumed because its retained identity changed`)
        }

        const { pause: _pause, ...queued } = structuredClone(run)
        resumed = { ...queued, state: 'queued', queueClass: 'resumption' }
        const next = structuredClone(current)
        next.runs[index] = resumed
        next.revision += 1
        return stateSchema.parse(next)
      })
      if (resumed === undefined) throw new Error(`run "${parsedRunId}" was not resumed`)
      return structuredClone(resumed)
    })
  }

  /**
   * Revalidate an allocated pause against the current tracker and execution policy, then atomically reserve the retained
   * run's remaining token cap and return it to `implementing`. The caller must first prove the retained Session readable
   * and supply exact current Git facts. Scheduler authorization cannot clear an operator hold; explicit operator
   * authorization can. Any failed or concurrent check leaves the pause unchanged.
   */
  async resumeActiveRun(
    runId: RunId,
    observedGit: GitExecutionSnapshot,
    authorization: ActiveResumeAuthorization,
  ): Promise<ImplementingRun> {
    const parsedRunId = runIdSchema.parse(runId)
    const parsedGit = executionSchema.shape.git.unwrap().parse(observedGit)
    const settings = this.dependencies.settings()
    validateExecutionSettings(settings)
    const providerId = trackerProviderId(settings.trackerProvider)
    const beforeRead = this.dependencies.state()
    if (beforeRead.scheduler.mode !== 'enabled') throw new Error('scheduler must be enabled to resume a run')
    if (beforeRead.budget.usageUncertain) {
      throw new Error('deployment token usage is uncertain; reconcile it before resuming')
    }
    const retained = beforeRead.runs.find((run) => run.runId === parsedRunId)
    if (!isPausedActiveRun(retained)) throw new Error(`run "${parsedRunId}" is not an allocated paused run`)
    validateActiveResumeFacts(retained, parsedGit, settings, authorization)

    return this.dependencies.tracker.withProvider(providerId, async (reader) => {
      const candidates = await readEveryCandidate(reader, providerId)
      const matches = candidates.filter(
        (issue) => issue.bindingId === retained.bindingId && issue.issueId === retained.issueId,
      )
      if (matches.length !== 1) {
        throw new Error(`run "${parsedRunId}" cannot be resumed because its tracker issue is not uniquely current`)
      }
      const issue = matches[0]
      if (issue === undefined) throw new Error(`run "${parsedRunId}" cannot be resumed without its tracker issue`)
      const evaluation = evaluateIssue(issue, settings.maxBriefBytes)
      if ('reason' in evaluation || !matchesRetainedIssue(retained, providerId, evaluation)) {
        throw new Error(`run "${parsedRunId}" cannot be resumed because its tracker authorization changed`)
      }

      let resumed: ImplementingRun | undefined
      await this.dependencies.table().update(STATE_KEY, (current) => {
        const currentSettings = this.dependencies.settings()
        if (current.scheduler.mode !== 'enabled') throw new Error('scheduler must be enabled to resume a run')
        if (current.budget.usageUncertain) {
          throw new Error('deployment token usage is uncertain; reconcile it before resuming')
        }
        if (trackerProviderId(currentSettings.trackerProvider) !== providerId) {
          throw new Error(`run "${parsedRunId}" cannot be resumed because the selected tracker provider changed`)
        }
        const currentEvaluation = evaluateIssue(issue, currentSettings.maxBriefBytes)
        const index = current.runs.findIndex((run) => run.runId === parsedRunId)
        const run = current.runs[index]
        if (!isPausedActiveRun(run)) throw new Error(`run "${parsedRunId}" is no longer paused`)
        if (
          'reason' in currentEvaluation ||
          !matchesRetainedIssue(run, providerId, currentEvaluation) ||
          JSON.stringify(run) !== JSON.stringify(retained)
        ) {
          throw new Error(`run "${parsedRunId}" cannot be resumed because its retained authorization changed`)
        }
        validateActiveResumeFacts(run, parsedGit, currentSettings, authorization)
        const reservation = Math.min(run.budget.allowanceTokens, run.budget.capTokens - run.budget.settledTokens)
        if (
          current.budget.settledTokens + current.budget.reservedTokens + reservation >
          currentSettings.deploymentTokenCap
        ) {
          throw new Error('deployment token cap cannot cover the retained run continuation')
        }

        const { pause: _pause, ...allocated } = structuredClone(run)
        resumed = {
          ...allocated,
          state: 'implementing',
          queueClass: 'resumption',
          execution: { ...allocated.execution, attempt: allocated.execution.attempt + 1 },
          budget: { ...allocated.budget, reservedTokens: reservation },
        }
        const next = structuredClone(current)
        next.runs[index] = resumed
        next.budget.reservedTokens += reservation
        next.revision += 1
        return stateSchema.parse(next)
      })
      if (resumed === undefined) throw new Error(`run "${parsedRunId}" was not resumed`)
      return structuredClone(resumed)
    })
  }

  /**
   * Persist a definite retained-resource incompatibility discovered before an allocated pause can resume. The run must
   * still be the same durable active pause; an identical recovery reason is idempotent. This operation starts no Agent,
   * releases no retained identity, and accepts no caller cancellation signal.
   */
  async requireActiveRecovery(runId: RunId, reason: ActiveRecoveryReason): Promise<PausedActiveRun> {
    const parsedRunId = runIdSchema.parse(runId)
    const parsedReason = z
      .enum(['composition-unavailable', 'session-unavailable', 'workspace-unavailable', 'worktree-mismatch'])
      .parse(reason) as ActiveRecoveryReason
    let recovery: PausedActiveRun | undefined
    await this.dependencies.table().update(STATE_KEY, (current) => {
      const index = current.runs.findIndex((run) => run.runId === parsedRunId)
      const run = current.runs[index]
      if (!isPausedActiveRun(run)) throw new Error(`run "${parsedRunId}" is no longer an allocated pause`)
      if (run.execution.recovery?.reason === parsedReason) {
        recovery = structuredClone(run)
        return current
      }
      if (run.execution.recovery !== undefined) {
        throw new Error(`run "${parsedRunId}" already requires ${run.execution.recovery.reason} recovery`)
      }

      recovery = {
        ...structuredClone(run),
        execution: {
          ...structuredClone(run.execution),
          recovery: { kind: 'required', reason: parsedReason, interruptedAt: new Date().toISOString() },
        },
      }
      const next = structuredClone(current)
      next.runs[index] = recovery
      next.revision += 1
      return stateSchema.parse(next)
    })
    if (recovery === undefined) throw new Error(`run "${parsedRunId}" recovery requirement was not recorded`)
    return structuredClone(recovery)
  }
}
