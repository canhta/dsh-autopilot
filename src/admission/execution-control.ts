import { validateFixtureExecutionSettings } from '../config.js'
import { MAX_OUTCOME_TEXT_BYTES, STATE_KEY } from './constants.js'
import type {
  ExecutionOutcome,
  GitExecutionSnapshot,
  ImplementingRun,
  PausingRun,
  QueuedRun,
  RunId,
  RunUsageSettlement,
  TerminalRun,
} from './model.js'
import {
  assertStateSize,
  compareQueuedRuns,
  executionFor,
  truncateUtf8,
  usageUncertaintyReason,
  validUsageSettlement,
} from './policy.js'
import type { AdmissionDependencies } from './ports.js'
import { executionSchema, outcomeSchema, stateSchema } from './state.js'

export class ExecutionControl {
  constructor(private readonly dependencies: AdmissionDependencies) {}

  /**
   * Atomically claim the highest-priority queued run and reserve its configured fixture allowance.
   * Returns undefined when the scheduler is not enabled or the queue is empty. Otherwise, explicit fixture execution
   * paths and positive caps are required. The claim stores immutable run/Session/worktree identities and its reservation
   * together; disabled execution, uncertain usage, insufficient capacity, invalid configuration, or durable-write
   * failure rejects without a partial claim. The method accepts no cancellation signal and does not start external work.
   */
  async claimNext(): Promise<ImplementingRun | undefined> {
    const settings = this.dependencies.settings()
    let claimed: ImplementingRun | undefined
    await this.dependencies.table().update(STATE_KEY, (current) => {
      if (current.scheduler.mode !== 'enabled') return current
      validateFixtureExecutionSettings(settings)
      if (current.budget.usageUncertain) {
        throw new Error('deployment token usage is uncertain; reconcile it before dispatch')
      }
      const queued = current.runs.filter((run): run is QueuedRun => run.state === 'queued').sort(compareQueuedRuns)[0]
      if (queued === undefined) return current
      if (
        current.budget.settledTokens + current.budget.reservedTokens + settings.runTokenAllowance >
        settings.deploymentTokenCap
      ) {
        throw new Error('deployment token cap cannot cover the configured run allowance')
      }

      const next = structuredClone(current)
      const index = next.runs.findIndex((run) => run.runId === queued.runId)
      if (index < 0) throw new Error('queued run disappeared during its atomic claim')
      claimed = {
        ...queued,
        state: 'implementing',
        execution: executionFor(queued, settings),
        budget: {
          capTokens: settings.perRunTokenCap,
          allowanceTokens: settings.runTokenAllowance,
          reservedTokens: settings.runTokenAllowance,
          settledTokens: 0,
          usageUncertain: false,
        },
      }
      next.runs[index] = claimed
      next.budget.reservedTokens += settings.runTokenAllowance
      next.revision += 1
      const parsed = stateSchema.parse(next)
      assertStateSize(parsed)
      return parsed
    })
    return claimed === undefined ? undefined : structuredClone(claimed)
  }

  /**
   * Persist exact Git facts for an implementing or pausing run before Agent creation and again after execution.
   * The run must exist, remain allocated, and not require recovery. Invalid evidence or durable-write failure
   * rejects without changing the prior snapshot. The atomic record update accepts no cancellation signal.
   */
  async recordWorktree(runId: RunId, git: GitExecutionSnapshot): Promise<ImplementingRun | PausingRun> {
    const parsedGit = executionSchema.shape.git.unwrap().parse(git)
    let recorded: ImplementingRun | PausingRun | undefined
    await this.dependencies.table().update(STATE_KEY, (current) => {
      const next = structuredClone(current)
      const index = next.runs.findIndex((run) => run.runId === runId)
      const run = next.runs[index]
      if (run?.state !== 'implementing' && run?.state !== 'pausing') {
        throw new Error(`run "${runId}" is not implementing or pausing`)
      }
      if (run.execution.recovery !== undefined) throw new Error(`run "${runId}" requires explicit recovery`)
      const nextRun: ImplementingRun | PausingRun = {
        ...run,
        execution: { ...run.execution, git: parsedGit },
      }
      recorded = nextRun
      next.runs[index] = nextRun
      next.revision += 1
      return stateSchema.parse(next)
    })
    if (recorded === undefined) throw new Error(`run "${runId}" worktree facts were not recorded`)
    return structuredClone(recorded)
  }

  /**
   * Atomically transition an implementing run to its structured terminal state and settle its reservation.
   * Verified outcomes require recorded Git facts. Known usage within both retained limits releases the reservation and
   * increments settled usage; missing, invalid, or excessive usage produces a failed outcome, retains the obligation,
   * and stops later authorization. Validation or durable-write failure leaves the prior snapshot unchanged. The method
   * accepts no cancellation signal.
   */
  async settle(runId: RunId, outcome: ExecutionOutcome, usage: RunUsageSettlement): Promise<TerminalRun> {
    const parsedOutcome = outcomeSchema.parse(outcome) as ExecutionOutcome
    let settled: TerminalRun | undefined
    await this.dependencies.table().update(STATE_KEY, (current) => {
      const next = structuredClone(current)
      const index = next.runs.findIndex((run) => run.runId === runId)
      const run = next.runs[index]
      if (run?.state !== 'implementing') throw new Error(`run "${runId}" is not implementing`)
      if (run.execution.git === undefined && parsedOutcome.kind === 'verified') {
        throw new Error(`verified run "${runId}" has no recorded worktree facts`)
      }
      const usageKnown = validUsageSettlement(run, usage)
      const reservedTokens = usageKnown ? 0 : run.budget.reservedTokens
      const settledTokens = usageKnown ? run.budget.settledTokens + usage.tokens : run.budget.settledTokens
      const terminalOutcome: ExecutionOutcome = usageKnown
        ? parsedOutcome
        : {
            kind: 'failed',
            summary: 'Provider token usage could not be settled safely.',
            evidence: [
              usage.kind === 'uncertain'
                ? truncateUtf8(usage.reason, MAX_OUTCOME_TEXT_BYTES) ||
                  'provider did not supply a usage uncertainty reason'
                : 'reported usage exceeded the reserved allowance',
            ],
          }
      const terminalRun: TerminalRun = {
        ...run,
        state: terminalOutcome.kind === 'verified' ? 'publishing' : terminalOutcome.kind,
        execution: structuredClone(run.execution),
        budget: {
          ...run.budget,
          reservedTokens,
          settledTokens,
          usageUncertain: !usageKnown,
          ...(usageKnown ? {} : { usageUncertaintyReason: usageUncertaintyReason(run, usage) }),
        },
        outcome: terminalOutcome,
        completedAt: new Date().toISOString(),
      }
      settled = terminalRun
      next.runs[index] = terminalRun
      if (usageKnown) {
        next.budget.reservedTokens -= run.budget.reservedTokens
        next.budget.settledTokens += usage.tokens
      } else {
        next.budget.usageUncertain = true
      }
      next.revision += 1
      return stateSchema.parse(next)
    })
    if (settled === undefined) throw new Error(`run "${runId}" was not settled`)
    return structuredClone(settled)
  }
}
