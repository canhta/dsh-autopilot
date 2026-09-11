import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { createUserMessage, type GenerateOptions, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type {
  ExecutionOutcome,
  GitExecutionSnapshot,
  ImplementingRun,
  RunUsageSettlement,
  TerminalRun,
} from './admission.js'

export const FIXTURE_PROVIDER = 'dsh-autopilot-fixture'
export const FIXTURE_MODEL = 'controlled'

const GIT_OUTPUT_LIMIT = 1024 * 1024
const GIT_GRACE_MS = 5_000
const GIT_TIMEOUT_MS = 30_000
const MAX_REPORT_SUMMARY_LENGTH = 4_096
const MAX_REPORT_EVIDENCE = 100
const MAX_REPORT_EVIDENCE_LENGTH = 4_096

declare module '@deepseek-ai/cordis' {
  interface Context {
    dispatch: Dispatch
  }
}

interface UsageRecorder {
  readonly usage: TokenUsage[]
  requests: number
  uncertainty?: string
}

interface ReportRecorder {
  outcome?: ExecutionOutcome
  violation?: string
}

/** Fixture-only durable dispatcher built from the DSH Agent, Session, Workspace, Tool, LLM, and Subprocess seams. */
export class Dispatch extends Service {
  static readonly inject = [
    'admission',
    'agents',
    'sessions',
    'sessionPersistence',
    'workspaceRegistry',
    'tools',
    'llm',
    'subprocess',
  ]

  constructor(ctx: Context) {
    super(ctx, 'dispatch')
  }

  /** Claim and execute the next queued run, or return undefined when no work is queued. */
  async dispatchNext(): Promise<TerminalRun | undefined> {
    const run = await this.ctx.admission.claimNext()
    if (run === undefined) return undefined

    const usage: UsageRecorder = { usage: [], requests: 0 }
    const report: ReportRecorder = {}
    let git: GitExecutionSnapshot | undefined
    try {
      await mkdir(dirname(run.execution.worktreePath), { recursive: true })
      const baseHead = (
        await gitCommand(this.ctx.subprocess, run.execution.targetRepository, ['rev-parse', run.execution.baseBranch])
      ).trim()
      await gitCommand(this.ctx.subprocess, run.execution.targetRepository, [
        'worktree',
        'add',
        '-b',
        run.execution.branch,
        run.execution.worktreePath,
        run.execution.baseBranch,
      ])
      git = await inspectGit(this.ctx.subprocess, run.execution.worktreePath, baseHead)
      await this.ctx.admission.recordWorktree(run.runId, git)

      const workspace: Workspace = await this.ctx.workspaceRegistry.create(run.execution.worktreePath, run.displayKey)
      const handle = await this.ctx.agents.create({
        sessionId: run.execution.sessionId,
        meta: { cwd: run.execution.worktreePath },
        agentOptions: {
          provider: FIXTURE_PROVIDER,
          model: FIXTURE_MODEL,
          maxTokens: run.budget.capTokens,
        },
        setup: (agentCtx) => {
          registerUsageRecorder(agentCtx, run, usage)
          agentCtx.tools.register(createReportTool(report))
        },
      })
      try {
        await workspace.attachSession(run.execution.sessionId)
        handle.agent.followup(
          createUserMessage({
            content: [{ type: 'text', text: executionPrompt(run) }],
            source: { kind: 'plugin', plugin: 'dsh-autopilot' },
          }),
        )
        await handle.agent.whenIdle()
        if (!(await this.ctx.sessions.flush(handle.agent.session))) {
          throw new Error(`session "${run.execution.sessionId}" has no persistence binding`)
        }
      } finally {
        await handle.dispose()
      }

      git = await inspectGit(this.ctx.subprocess, run.execution.worktreePath, baseHead)
      await this.ctx.admission.recordWorktree(run.runId, git)
      const outcome = validatedOutcome(report, git)
      return await this.ctx.admission.settle(run.runId, outcome, usageSettlement(usage))
    } catch (error) {
      const message = errorMessage(error)
      if (git !== undefined) {
        try {
          git = await inspectGit(this.ctx.subprocess, run.execution.worktreePath, git.baseHead)
          await this.ctx.admission.recordWorktree(run.runId, git)
        } catch {
          // The original actionable failure remains authoritative; best-effort evidence must not replace it.
        }
      }
      return await this.ctx.admission.settle(
        run.runId,
        { kind: 'failed', summary: 'Fixture dispatch failed.', evidence: [message] },
        usageSettlement(usage),
      )
    }
  }
}

function createReportTool(recorder: ReportRecorder) {
  return defineTool({
    name: 'autopilot_report',
    description: 'Submit the single structured terminal report for this Autopilot fixture run.',
    parameters: {
      kind: { type: 'string', enum: ['verified', 'blocked', 'failed'], required: true },
      summary: { type: 'string', required: true },
      evidence: { type: 'array', items: { type: 'string' }, required: true },
    },
    output: {
      schema: { type: 'string', const: 'accepted' },
      render: () => [{ type: 'text', text: 'Autopilot accepted the terminal report.' }],
    },
    async execute(args) {
      if (recorder.outcome !== undefined) {
        recorder.violation = 'the model submitted more than one terminal report'
        throw new Error(recorder.violation)
      }
      if (args.summary.length === 0 || args.summary.length > MAX_REPORT_SUMMARY_LENGTH) {
        throw new TypeError('report summary must be non-empty and within its durable limit')
      }
      if (
        args.evidence.length > MAX_REPORT_EVIDENCE ||
        args.evidence.some((entry) => entry.length === 0 || entry.length > MAX_REPORT_EVIDENCE_LENGTH)
      ) {
        throw new TypeError('report evidence must contain only bounded non-empty entries')
      }
      recorder.outcome = {
        kind: args.kind,
        summary: args.summary,
        evidence: [...args.evidence],
      }
      return 'accepted' as const
    },
  })
}

function registerUsageRecorder(agentCtx: Context, run: ImplementingRun, recorder: UsageRecorder): void {
  agentCtx.on('llm/stream', async function* (options: GenerateOptions, next): AsyncIterable<StreamChunk> {
    recorder.requests += 1
    if (
      options.provider !== FIXTURE_PROVIDER ||
      options.model !== FIXTURE_MODEL ||
      options.sessionId !== run.execution.sessionId
    ) {
      recorder.uncertainty = 'a model request escaped the claimed fixture provider, model, or session identity'
    }
    let usageChunks = 0
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') {
          usageChunks += 1
          if (validTokenUsage(chunk.usage)) recorder.usage.push(structuredClone(chunk.usage))
          else recorder.uncertainty = 'the fixture provider returned invalid token usage'
        }
        yield chunk
      }
    } finally {
      if (usageChunks !== 1) recorder.uncertainty = 'a fixture model request did not return exactly one usage record'
    }
  })
}

function validTokenUsage(usage: TokenUsage): boolean {
  return [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  )
}

function usageSettlement(recorder: UsageRecorder): RunUsageSettlement {
  if (recorder.uncertainty !== undefined) return { kind: 'uncertain', reason: recorder.uncertainty }
  if (recorder.usage.length !== recorder.requests) {
    return { kind: 'uncertain', reason: 'provider usage records did not match the number of model requests' }
  }
  const tokens = recorder.usage.reduce(
    (total, current) =>
      total +
      current.inputTokens +
      current.outputTokens +
      (current.cacheReadTokens ?? 0) +
      (current.cacheWriteTokens ?? 0),
    0,
  )
  return Number.isSafeInteger(tokens)
    ? { kind: 'known', tokens }
    : { kind: 'uncertain', reason: 'provider usage overflowed the safe integer range' }
}

function validatedOutcome(report: ReportRecorder, git: GitExecutionSnapshot): ExecutionOutcome {
  if (report.violation !== undefined) {
    return { kind: 'failed', summary: 'The fixture model violated the report contract.', evidence: [report.violation] }
  }
  if (report.outcome === undefined) {
    return { kind: 'failed', summary: 'The fixture model did not submit a terminal report.', evidence: [] }
  }
  if (report.outcome.kind === 'verified' && git.status !== '') {
    return {
      kind: 'failed',
      summary: 'The fixture model reported verification with an uncommitted worktree.',
      evidence: [git.status],
    }
  }
  return report.outcome
}

function executionPrompt(run: ImplementingRun): string {
  return `Execute the approved Agent Brief below in the managed fixture worktree. Use autopilot_report exactly once with a verified, blocked, or failed outcome before finishing.\n\n${run.brief.content}`
}

async function inspectGit(
  subprocess: SubprocessRuntime,
  worktreePath: string,
  baseHead: string,
): Promise<GitExecutionSnapshot> {
  const head = (await gitCommand(subprocess, worktreePath, ['rev-parse', 'HEAD'])).trim()
  const status = await gitCommand(subprocess, worktreePath, ['status', '--porcelain'])
  return { baseHead, head, status }
}

async function gitCommand(subprocess: SubprocessRuntime, cwd: string, args: readonly string[]): Promise<string> {
  const executable = await subprocess.resolveExecutable('git')
  const signal = AbortSignal.timeout(GIT_TIMEOUT_MS)
  const handle = subprocess.spawn({
    argv: [executable, ...args],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: GIT_OUTPUT_LIMIT },
      stderr: { maxBytes: GIT_OUTPUT_LIMIT },
    },
    graceMs: GIT_GRACE_MS,
    signal,
  })
  let outcome: Awaited<typeof handle.done> | undefined
  let commandError: unknown
  try {
    outcome = await handle.done
  } catch (error) {
    commandError = error
  }
  let quiescenceError: unknown
  try {
    if (!(await handle.waitForExit(AbortSignal.timeout(GIT_GRACE_MS * 2)))) {
      quiescenceError = new Error(`git ${args[0] ?? ''} left a live managed process`)
    }
  } catch (error) {
    quiescenceError = error
  }
  if (commandError !== undefined) {
    if (quiescenceError !== undefined) {
      throw new AggregateError([commandError, quiescenceError], `git ${args[0] ?? ''} failed and did not quiesce`)
    }
    throw commandError
  }
  if (quiescenceError !== undefined) throw quiescenceError
  if (outcome === undefined) throw new Error(`git ${args[0] ?? ''} produced no process outcome`)
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  if (stdout?.lossy || stderr?.lossy) throw new Error(`git ${args[0] ?? ''} output exceeded its safety bound`)
  if (signal.aborted) throw new Error(`git ${args.join(' ')} timed out`)
  if (outcome.exitCode !== 0) {
    const diagnostic = stderr?.text.trim() || stdout?.text.trim() || `exit ${String(outcome.exitCode)}`
    throw new Error(`git ${args.join(' ')} failed: ${diagnostic}`)
  }
  return stdout?.text ?? ''
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default Dispatch
