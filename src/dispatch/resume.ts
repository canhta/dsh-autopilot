import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type {
  ActiveRecoveryReason,
  ActiveResumeAuthorization,
  GitExecutionSnapshot,
  ImplementingRun,
  PausedActiveRun,
  RunId,
} from '../admission.js'
import { FIXTURE_MODEL, FIXTURE_PROVIDER } from './contract.js'
import { type ActiveExecution, activeExecution, currentRun, isPausedActive, sameGit } from './execution-state.js'
import { inspectRetainedWorktree } from './git.js'
import { createReportTool, errorMessage, type ReportRecorder } from './report.js'
import { configureFixtureTools, registerUsageRecorder, type UsageRecorder } from './usage.js'

export interface PreparedResume {
  readonly run: ImplementingRun
  readonly active: ActiveExecution
  readonly handle: AgentHandle
  readonly usage: UsageRecorder
  readonly report: ReportRecorder
  readonly workspace: Workspace
  readonly baseHead: string
}

export async function preparePausedResume(
  ctx: Context,
  activeExecutions: Map<RunId, ActiveExecution>,
  runId: RunId,
  authorization: ActiveResumeAuthorization,
): Promise<PreparedResume> {
  const snapshot = ctx.admission.snapshot()
  if (snapshot.scheduler.mode !== 'enabled') throw new Error('scheduler must be enabled to resume a run')
  if (snapshot.budget.usageUncertain) {
    throw new Error('deployment token usage is uncertain; reconcile it before resuming')
  }
  const paused = currentRun(snapshot, runId)
  if (!isPausedActive(paused)) throw new Error(`run "${runId}" is not an allocated paused run`)
  if (paused.execution.recovery !== undefined) {
    throw new Error(`run "${runId}" requires explicit ${paused.execution.recovery.reason} recovery`)
  }
  const remainingTokens = paused.budget.capTokens - paused.budget.settledTokens
  if (remainingTokens <= 0) throw new Error(`run "${runId}" has no retained token capacity`)
  const continuationAllowance = Math.min(paused.budget.allowanceTokens, remainingTokens)
  const persisted: SessionPersistenceSnapshot | undefined = await ctx.sessionPersistence.stat(
    paused.execution.sessionId,
  )
  if (persisted?.header.id !== paused.execution.sessionId || persisted.header.cwd !== paused.execution.worktreePath) {
    return await rejectResumeForRecovery(
      ctx,
      paused,
      'session-unavailable',
      `run "${runId}" retained Session is unavailable or incompatible and requires explicit recovery`,
    )
  }
  const retainedGit = paused.execution.git
  if (retainedGit === undefined) throw new Error(`run "${runId}" has no retained Git checkpoint`)
  const workspace = await ctx.workspaceRegistry.resolveByPath(paused.execution.worktreePath)
  if (workspace === undefined || !workspace.sessionIds.includes(paused.execution.sessionId)) {
    return await rejectResumeForRecovery(
      ctx,
      paused,
      'workspace-unavailable',
      `run "${runId}" retained workspace ownership is unavailable and requires explicit recovery`,
    )
  }
  let observedGit: GitExecutionSnapshot
  try {
    observedGit = await inspectRetainedWorktree(ctx.subprocess, paused)
  } catch (error) {
    return await rejectResumeForRecovery(
      ctx,
      paused,
      'worktree-mismatch',
      `run "${runId}" retained worktree is unavailable or incompatible and requires explicit recovery: ${errorMessage(error)}`,
    )
  }
  if (!sameGit(retainedGit, observedGit)) {
    return await rejectResumeForRecovery(
      ctx,
      paused,
      'worktree-mismatch',
      `run "${runId}" retained Git state changed and requires explicit recovery`,
    )
  }
  const usage: UsageRecorder = { usage: [], requests: 0 }
  const report: ReportRecorder = {}
  const handle = await ctx.agents.resume({
    resumeSessionId: paused.execution.sessionId,
    agentOptions: {
      provider: FIXTURE_PROVIDER,
      model: FIXTURE_MODEL,
      maxTokens: continuationAllowance,
    },
    setup: (agentCtx) => {
      configureFixtureTools(agentCtx)
      registerUsageRecorder(agentCtx, paused, usage)
      agentCtx.tools.register(createReportTool(report))
    },
  })

  let resumed: ImplementingRun
  try {
    resumed = await ctx.admission.resumeActiveRun(runId, observedGit, authorization)
  } catch (error) {
    await handle.dispose()
    throw error
  }
  const active = activeExecution()
  active.handle = handle
  activeExecutions.set(runId, active)
  return { run: resumed, active, handle, usage, report, workspace, baseHead: retainedGit.baseHead }
}

async function rejectResumeForRecovery(
  ctx: Context,
  paused: PausedActiveRun,
  reason: ActiveRecoveryReason,
  message: string,
): Promise<never> {
  await ctx.admission.requireActiveRecovery(paused.runId, reason)
  throw new Error(message)
}
