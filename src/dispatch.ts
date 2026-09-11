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
const MAX_REPORT_TEXT_BYTES = 4 * 1024
const MAX_REPORT_EVIDENCE = 100
const textEncoder = new TextEncoder()

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

  /**
   * Claim and execute the next queued run through the controlled fixture model, or return undefined when the queue is
   * empty. Requires the injected DSH execution services, a registered fixture adapter, valid fixture Settings, and Git.
   * The method reserves durable budget before Git/model effects, owns the root Agent to quiescence, flushes its Session,
   * records final Git facts, and settles a structured terminal outcome. Setup/model/Git failures become a failed run
   * when the aggregate remains writable; an aggregate write failure rejects for explicit recovery. This first-slice
   * operation accepts no caller cancellation signal.
   */
  async dispatchNext(): Promise<TerminalRun | undefined> {
    const claimed = await this.ctx.admission.claimNext()
    if (claimed === undefined) return undefined
    let run = claimed

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
      run = await this.ctx.admission.recordWorktree(run.runId, git)

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
        { kind: 'failed', summary: 'Fixture dispatch failed.', evidence: [truncateUtf8(message)] },
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
      gitHead: { type: 'string' },
      gitStatus: { type: 'string' },
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
      if (args.summary.length === 0 || textEncoder.encode(args.summary).byteLength > MAX_REPORT_TEXT_BYTES) {
        throw new TypeError('report summary must be non-empty and within its durable limit')
      }
      if (
        args.evidence.length > MAX_REPORT_EVIDENCE ||
        args.evidence.some(
          (entry) => entry.length === 0 || textEncoder.encode(entry).byteLength > MAX_REPORT_TEXT_BYTES,
        )
      ) {
        throw new TypeError('report evidence must contain only bounded non-empty entries')
      }
      if (args.kind === 'verified') {
        if (args.gitHead === undefined || !/^[a-f0-9]{40,64}$/.test(args.gitHead) || args.gitStatus === undefined) {
          throw new TypeError('verified reports require an exact Git head and status')
        }
        recorder.outcome = {
          kind: args.kind,
          summary: args.summary,
          evidence: [...args.evidence],
          reportedGit: { head: args.gitHead, status: args.gitStatus },
        }
      } else {
        if (args.gitHead !== undefined || args.gitStatus !== undefined) {
          throw new TypeError('blocked and failed reports must not claim verified Git facts')
        }
        recorder.outcome = { kind: args.kind, summary: args.summary, evidence: [...args.evidence] }
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
  if (
    report.outcome.kind === 'verified' &&
    (report.outcome.reportedGit.head !== git.head || report.outcome.reportedGit.status !== git.status)
  ) {
    return {
      kind: 'failed',
      summary: 'The fixture model reported Git facts that do not match the managed worktree.',
      evidence: [truncateUtf8(`head=${git.head}\nstatus=${git.status}`)],
    }
  }
  return report.outcome
}

function executionPrompt(run: ImplementingRun): string {
  const git = run.execution.git
  if (git === undefined) throw new Error('the managed worktree has no durable Git facts')
  return `Execute the approved Agent Brief below in the managed fixture worktree. Use autopilot_report exactly once with a verified, blocked, or failed outcome before finishing. A verified report must repeat the exact final Git head and porcelain status.\n\nManaged Git head: ${git.head}\nManaged Git status: ${JSON.stringify(git.status)}\n\n${run.brief.content}`
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
  const message = error instanceof Error ? error.message : String(error)
  return message || 'unknown fixture dispatch failure'
}

function truncateUtf8(value: string): string {
  if (textEncoder.encode(value).byteLength <= MAX_REPORT_TEXT_BYTES) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (textEncoder.encode(value.slice(0, middle)).byteLength <= MAX_REPORT_TEXT_BYTES) low = middle
    else high = middle - 1
  }
  return value.slice(0, low)
}

export default Dispatch
