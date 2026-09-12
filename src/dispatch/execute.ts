import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionHandleClosedError } from '@deepseek-ai/dsh-session-persistence'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { GitExecutionSnapshot, ImplementingRun, PausingRun } from '../admission.js'
import {
  applyAgentPermission,
  assertAgentCompositionAvailable,
  modelSelection,
  mountAgentComposition,
  requiredAgentComposition,
} from './composition.js'
import type { DispatchResult } from './contract.js'
import type { ActiveExecution } from './execution-state.js'
import { currentRun } from './execution-state.js'
import { gitCommand, inspectGit } from './git.js'
import {
  createReportTool,
  errorMessage,
  executionPrompt,
  type ReportRecorder,
  truncateUtf8,
  validatedOutcome,
} from './report.js'
import { registerUsageRecorder, type UsageRecorder, usageSettlement } from './usage.js'

export async function executeClaimed(
  ctx: Context,
  claimed: ImplementingRun,
  active: ActiveExecution,
  finishStart: () => void,
): Promise<DispatchResult> {
  let run: ImplementingRun | PausingRun = claimed
  const usage: UsageRecorder = { usage: [], requests: 0 }
  const report: ReportRecorder = {}
  let git: GitExecutionSnapshot | undefined
  let baseHead: string
  let handle: AgentHandle
  let workspace: Workspace
  try {
    const composition = requiredAgentComposition(run.execution)
    await assertAgentCompositionAvailable(ctx, composition)
    await mkdir(dirname(run.execution.worktreePath), { recursive: true })
    baseHead = (
      await gitCommand(ctx.subprocess, run.execution.targetRepository, ['rev-parse', run.execution.baseBranch])
    ).trim()
    await gitCommand(ctx.subprocess, run.execution.targetRepository, [
      'worktree',
      'add',
      '-b',
      run.execution.branch,
      run.execution.worktreePath,
      run.execution.baseBranch,
    ])
    git = await inspectGit(ctx.subprocess, run.execution.worktreePath, baseHead)
    run = await ctx.admission.recordWorktree(run.runId, git)

    workspace = await ctx.workspaceRegistry.create(run.execution.worktreePath, run.displayKey)
    const selected = modelSelection(composition)
    handle = await ctx.agents.create({
      sessionId: run.execution.sessionId,
      meta: { cwd: run.execution.worktreePath, agentPreset: composition.presetId },
      agentOptions: {
        ...selected,
        maxTokens: run.budget.capTokens,
      },
      setup: async (agentCtx) => {
        await mountAgentComposition(ctx, agentCtx, composition)
        registerUsageRecorder(agentCtx, run, composition, usage)
        agentCtx.tools.register(createReportTool(report))
      },
    })
    try {
      applyAgentPermission(ctx, handle.agent.session, composition)
    } catch (error) {
      await handle.dispose()
      throw error
    }
    active.handle = handle
    finishStart()
  } catch (error) {
    return await settleExecutionFailure(ctx, run, git, usage, error, 'Agent execution failed.')
  }

  return await executeOwnedTurn(
    ctx,
    run,
    active,
    handle,
    usage,
    report,
    baseHead,
    executionPrompt(run),
    'pause requested before Agent start',
    'Agent execution failed.',
    workspace,
  )
}

export async function executeOwnedTurn(
  ctx: Context,
  run: ImplementingRun | PausingRun,
  active: ActiveExecution,
  handle: AgentHandle,
  usage: UsageRecorder,
  report: ReportRecorder,
  baseHead: string,
  prompt: string,
  cancellationReason: string,
  failureSummary: string,
  existingWorkspace?: Workspace,
  beforeCheckpoint?: () => Promise<void>,
): Promise<DispatchResult> {
  let git = run.execution.git
  let rootQuiescent = false
  let rootDisposed = false
  let sessionDurable = false
  let finalGitObserved = false
  try {
    const workspace =
      existingWorkspace ?? (await ctx.workspaceRegistry.create(run.execution.worktreePath, run.displayKey))
    try {
      await workspace.attachSession(run.execution.sessionId)
      const current = currentRun(ctx.admission.snapshot(), run.runId)
      if (current.state === 'pausing' || active.pauseRequested) {
        active.pauseRequested = true
        handle.agent.cancel({ kind: 'hook', reason: cancellationReason }, { keepInbox: true })
      } else {
        handle.agent.followup(
          createUserMessage({
            content: [{ type: 'text', text: prompt }],
            source: { kind: 'plugin', plugin: 'dsh-autopilot' },
          }),
        )
      }
      await handle.agent.whenIdle()
      await beforeCheckpoint?.()
      rootQuiescent = true
      if (!(await ctx.sessions.flush(handle.agent.session))) {
        throw new Error(`session "${run.execution.sessionId}" has no persistence binding`)
      }
      sessionDurable = true
    } finally {
      await handle.dispose()
      rootDisposed = true
    }

    git = await inspectGit(ctx.subprocess, run.execution.worktreePath, baseHead)
    await beforeCheckpoint?.()
    finalGitObserved = true
    const recorded = await ctx.admission.recordWorktree(run.runId, git)
    await beforeCheckpoint?.()
    const current = currentRun(ctx.admission.snapshot(), run.runId)
    if (recorded.state === 'pausing' || current.state === 'pausing') {
      return await ctx.admission.checkpointPaused(run.runId, git, usageSettlement(usage))
    }
    return await ctx.admission.settle(run.runId, validatedOutcome(report, git), usageSettlement(usage))
  } catch (error) {
    const durableProviderTeardown = rootDisposed && error instanceof SessionHandleClosedError
    return await settleExecutionFailure(ctx, run, git, usage, error, failureSummary, {
      rootQuiescent,
      sessionDurable: sessionDurable || durableProviderTeardown,
      finalGitObserved,
    })
  }
}

async function settleExecutionFailure(
  ctx: Context,
  run: ImplementingRun | PausingRun,
  git: GitExecutionSnapshot | undefined,
  usage: UsageRecorder,
  error: unknown,
  failureSummary: string,
  checkpoint = { rootQuiescent: false, sessionDurable: false, finalGitObserved: false },
): Promise<DispatchResult> {
  let observedGit = git
  let finalGitObserved = checkpoint.finalGitObserved
  if (observedGit !== undefined) {
    try {
      observedGit = await inspectGit(ctx.subprocess, run.execution.worktreePath, observedGit.baseHead)
      finalGitObserved = true
      await ctx.admission.recordWorktree(run.runId, observedGit)
    } catch {
      // The original actionable failure remains authoritative; best-effort evidence must not replace it.
    }
  }
  const current = currentRun(ctx.admission.snapshot(), run.runId)
  if (current.state === 'pausing') {
    if (checkpoint.rootQuiescent && checkpoint.sessionDurable && finalGitObserved && observedGit !== undefined) {
      return await ctx.admission.checkpointPaused(run.runId, observedGit, usageSettlement(usage))
    }
    throw error
  }
  return await ctx.admission.settle(
    run.runId,
    { kind: 'failed', summary: failureSummary, evidence: [truncateUtf8(errorMessage(error))] },
    usageSettlement(usage),
  )
}
