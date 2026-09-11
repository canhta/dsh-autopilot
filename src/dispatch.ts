import { mkdir, realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type GenerateOptions, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionHandleClosedError, type SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type {
  ActiveRecoveryReason,
  ActiveResumeAuthorization,
  AdmissionSnapshot,
  AutopilotRun,
  ExecutionOutcome,
  GitExecutionSnapshot,
  ImplementingRun,
  PausedActiveRun,
  PausingRun,
  RunId,
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

interface ActiveExecution {
  handle?: AgentHandle
  pauseRequested: boolean
  readonly completion: Promise<void>
  complete(): void
}

interface PreparedResume {
  readonly run: ImplementingRun
  readonly active: ActiveExecution
  readonly handle: AgentHandle
  readonly usage: UsageRecorder
  readonly report: ReportRecorder
  readonly workspace: Workspace
  readonly baseHead: string
}

type DispatchResult = TerminalRun | PausedActiveRun

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

  private readonly active = new Map<RunId, ActiveExecution>()
  private readonly starts = new Set<Promise<void>>()
  private accepting = false

  constructor(ctx: Context) {
    super(ctx, 'dispatch')
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    this.accepting = true
    yield async () => {
      this.accepting = false
      await Promise.all([...this.starts])
      const owned = [...this.active.values()]
      const pausingRunIds = await this.ctx.admission.requestServiceWithdrawalPause()
      const settled = await Promise.allSettled([
        ...pausingRunIds.map((runId) => this.pauseOwnedExecution(runId, 'required execution service withdrawn')),
        ...owned.map((execution) => execution.completion),
      ])
      const failures = settled.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
      if (failures.length > 0) throw new AggregateError(failures, 'dispatcher withdrawal did not quiesce cleanly')
    }
  }

  /**
   * Claim and execute the next queued run through the controlled fixture model, or return undefined when the queue is
   * empty. Requires the injected DSH execution services, a registered fixture adapter, valid fixture Settings, and Git.
   * The method reserves durable budget before Git/model effects, owns the root Agent to quiescence, flushes its Session,
   * records final Git facts, and settles a structured terminal outcome. Setup/model/Git failures become a failed run
   * when the aggregate remains writable; an aggregate write failure rejects for explicit recovery. This first-slice
   * operation accepts no caller cancellation signal.
   */
  async dispatchNext(): Promise<DispatchResult | undefined> {
    this.assertAccepting()
    const snapshot = this.ctx.admission.snapshot()
    if (snapshot.scheduler.mode === 'enabled') {
      const continuation = snapshot.runs.find(
        (run): run is PausedActiveRun =>
          isPausedActive(run) && !run.pause.operatorHold && run.execution.recovery === undefined,
      )
      if (continuation !== undefined) return await this.resumePaused(continuation.runId, 'scheduler')
    }
    const finishStart = this.beginStart()
    let claimed: ImplementingRun | undefined
    let active: ActiveExecution | undefined
    try {
      claimed = await this.ctx.admission.claimNext()
      if (claimed === undefined) {
        finishStart()
        return undefined
      }
      active = activeExecution()
      this.active.set(claimed.runId, active)
    } catch (error) {
      finishStart()
      throw error
    }
    try {
      return await this.executeClaimed(claimed, active, finishStart)
    } finally {
      finishStart()
      this.active.delete(claimed.runId)
      active.complete()
    }
  }

  /**
   * Atomically disable scheduler admission/dequeue, request native cancellation for every live root, and resolve only
   * after each owned execution has reached a durable pause checkpoint. Cancellation-resistant work remains `pausing`
   * and keeps its reservation while this operation waits. Recovered runs without a live owner remain explicit recovery.
   */
  async disableScheduler(): Promise<AdmissionSnapshot> {
    this.assertAccepting()
    const requested = await this.ctx.admission.requestSchedulerDisable()
    await Promise.all(requested.pausingRunIds.map((runId) => this.pauseOwnedExecution(runId, 'scheduler disabled')))
    return this.ctx.admission.snapshot()
  }

  /**
   * Request an operator hold for one live allocated run, cancel its native root, and resolve only after its Session and
   * Autopilot checkpoint are durable. Queued work must use `Admission.holdQueued`; absent live ownership rejects.
   */
  async stopRun(runId: RunId): Promise<PausedActiveRun> {
    this.assertAccepting()
    const active = this.active.get(runId)
    if (active === undefined) throw new Error(`run "${runId}" has no live execution owner`)
    const requested = await this.ctx.admission.requestRunPause(runId)
    if (requested.state === 'paused') return requested
    await this.pauseOwnedExecution(runId, 'operator requested a checkpoint stop')
    const paused = this.ctx.admission.snapshot().runs.find((run) => run.runId === runId)
    if (!isPausedActive(paused)) throw new Error(`run "${runId}" did not reach a durable pause checkpoint`)
    return paused
  }

  /**
   * Resume one allocated pause through DSH's persisted Session path after proving the retained Session and Git worktree
   * are still usable. The same run, Session, worktree, and branch are retained; no fallback identity is created. Tracker,
   * scheduler, routing, Git, and budget gates are revalidated before the resumed Agent receives continuation input.
   * Definite retained-resource failures persist an explicit recovery requirement; other preflight failures preserve the
   * pause. The operation owns the resumed root through disposal and accepts no caller cancellation signal.
   */
  async resumeRun(runId: RunId): Promise<DispatchResult> {
    this.assertAccepting()
    return await this.resumePaused(runId, 'operator')
  }

  private async resumePaused(runId: RunId, authorization: ActiveResumeAuthorization): Promise<DispatchResult> {
    const finishStart = this.beginStart()
    let prepared: PreparedResume
    try {
      prepared = await this.preparePausedResume(runId, authorization)
    } finally {
      finishStart()
    }
    const { run, active, handle, usage, report, baseHead, workspace } = prepared
    try {
      return await this.executeOwnedTurn(
        run,
        active,
        handle,
        usage,
        report,
        baseHead,
        continuationPrompt(run),
        'pause requested before continuation',
        'Fixture continuation failed.',
        workspace,
      )
    } finally {
      this.active.delete(runId)
      active.complete()
    }
  }

  private async preparePausedResume(runId: RunId, authorization: ActiveResumeAuthorization): Promise<PreparedResume> {
    const snapshot = this.ctx.admission.snapshot()
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
    const persisted: SessionPersistenceSnapshot | undefined = await this.ctx.sessionPersistence.stat(
      paused.execution.sessionId,
    )
    if (persisted?.header.id !== paused.execution.sessionId || persisted.header.cwd !== paused.execution.worktreePath) {
      return await this.rejectResumeForRecovery(
        paused,
        'session-unavailable',
        `run "${runId}" retained Session is unavailable or incompatible and requires explicit recovery`,
      )
    }
    const retainedGit = paused.execution.git
    if (retainedGit === undefined) throw new Error(`run "${runId}" has no retained Git checkpoint`)
    const workspace = await this.ctx.workspaceRegistry.resolveByPath(paused.execution.worktreePath)
    if (workspace === undefined || !workspace.sessionIds.includes(paused.execution.sessionId)) {
      return await this.rejectResumeForRecovery(
        paused,
        'workspace-unavailable',
        `run "${runId}" retained workspace ownership is unavailable and requires explicit recovery`,
      )
    }
    let observedGit: GitExecutionSnapshot
    try {
      observedGit = await inspectRetainedWorktree(this.ctx.subprocess, paused)
    } catch (error) {
      return await this.rejectResumeForRecovery(
        paused,
        'worktree-mismatch',
        `run "${runId}" retained worktree is unavailable or incompatible and requires explicit recovery: ${errorMessage(error)}`,
      )
    }
    if (!sameGit(retainedGit, observedGit)) {
      return await this.rejectResumeForRecovery(
        paused,
        'worktree-mismatch',
        `run "${runId}" retained Git state changed and requires explicit recovery`,
      )
    }
    const usage: UsageRecorder = { usage: [], requests: 0 }
    const report: ReportRecorder = {}
    const handle = await this.ctx.agents.resume({
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
      resumed = await this.ctx.admission.resumeActiveRun(runId, observedGit, authorization)
    } catch (error) {
      await handle.dispose()
      throw error
    }
    const active = activeExecution()
    active.handle = handle
    this.active.set(runId, active)
    return { run: resumed, active, handle, usage, report, workspace, baseHead: retainedGit.baseHead }
  }

  private async pauseOwnedExecution(runId: RunId, reason: string): Promise<void> {
    const active = this.active.get(runId)
    if (active === undefined) {
      const run = currentRun(this.ctx.admission.snapshot(), runId)
      if (run.state === 'pausing' && run.execution.recovery === undefined) {
        throw new Error(`run "${runId}" is pausing without a live execution owner`)
      }
      return
    }
    active.pauseRequested = true
    active.handle?.agent.cancel({ kind: 'hook', reason }, { keepInbox: true })
    await active.completion
    const run = currentRun(this.ctx.admission.snapshot(), runId)
    if (run.state === 'pausing' && run.execution.recovery === undefined) {
      throw new Error(`run "${runId}" quiesced without a durable pause checkpoint`)
    }
  }

  private async rejectResumeForRecovery(
    paused: PausedActiveRun,
    reason: ActiveRecoveryReason,
    message: string,
  ): Promise<never> {
    await this.ctx.admission.requireActiveRecovery(paused.runId, reason)
    throw new Error(message)
  }

  private assertAccepting(): void {
    if (!this.accepting) throw new Error('dispatcher is unavailable while its required services are changing')
  }

  private beginStart(): () => void {
    this.assertAccepting()
    let resolve: (() => void) | undefined
    const barrier = new Promise<void>((settled) => {
      resolve = settled
    })
    this.starts.add(barrier)
    let finished = false
    return () => {
      if (finished) return
      finished = true
      this.starts.delete(barrier)
      resolve?.()
    }
  }

  private async executeClaimed(
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
      await mkdir(dirname(run.execution.worktreePath), { recursive: true })
      baseHead = (
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

      workspace = await this.ctx.workspaceRegistry.create(run.execution.worktreePath, run.displayKey)
      handle = await this.ctx.agents.create({
        sessionId: run.execution.sessionId,
        meta: { cwd: run.execution.worktreePath },
        agentOptions: {
          provider: FIXTURE_PROVIDER,
          model: FIXTURE_MODEL,
          maxTokens: run.budget.capTokens,
        },
        setup: (agentCtx) => {
          configureFixtureTools(agentCtx)
          registerUsageRecorder(agentCtx, run, usage)
          agentCtx.tools.register(createReportTool(report))
        },
      })
      active.handle = handle
      finishStart()
    } catch (error) {
      return await this.settleExecutionFailure(run, git, usage, error, 'Fixture dispatch failed.')
    }

    return await this.executeOwnedTurn(
      run,
      active,
      handle,
      usage,
      report,
      baseHead,
      executionPrompt(run),
      'pause requested before Agent start',
      'Fixture dispatch failed.',
      workspace,
    )
  }

  private async executeOwnedTurn(
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
  ): Promise<DispatchResult> {
    let git = run.execution.git
    let rootQuiescent = false
    let rootDisposed = false
    let sessionDurable = false
    let finalGitObserved = false
    try {
      const workspace =
        existingWorkspace ?? (await this.ctx.workspaceRegistry.create(run.execution.worktreePath, run.displayKey))
      try {
        await workspace.attachSession(run.execution.sessionId)
        const current = currentRun(this.ctx.admission.snapshot(), run.runId)
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
        rootQuiescent = true
        if (!(await this.ctx.sessions.flush(handle.agent.session))) {
          throw new Error(`session "${run.execution.sessionId}" has no persistence binding`)
        }
        sessionDurable = true
      } finally {
        await handle.dispose()
        rootDisposed = true
      }

      git = await inspectGit(this.ctx.subprocess, run.execution.worktreePath, baseHead)
      finalGitObserved = true
      const recorded = await this.ctx.admission.recordWorktree(run.runId, git)
      if (recorded.state === 'pausing') {
        return await this.ctx.admission.checkpointPaused(run.runId, git, usageSettlement(usage))
      }
      return await this.ctx.admission.settle(run.runId, validatedOutcome(report, git), usageSettlement(usage))
    } catch (error) {
      const durableProviderTeardown = rootDisposed && error instanceof SessionHandleClosedError
      return await this.settleExecutionFailure(run, git, usage, error, failureSummary, {
        rootQuiescent,
        sessionDurable: sessionDurable || durableProviderTeardown,
        finalGitObserved,
      })
    }
  }

  private async settleExecutionFailure(
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
        observedGit = await inspectGit(this.ctx.subprocess, run.execution.worktreePath, observedGit.baseHead)
        finalGitObserved = true
        await this.ctx.admission.recordWorktree(run.runId, observedGit)
      } catch {
        // The original actionable failure remains authoritative; best-effort evidence must not replace it.
      }
    }
    const current = currentRun(this.ctx.admission.snapshot(), run.runId)
    if (current.state === 'pausing') {
      if (checkpoint.rootQuiescent && checkpoint.sessionDurable && finalGitObserved && observedGit !== undefined) {
        return await this.ctx.admission.checkpointPaused(run.runId, observedGit, usageSettlement(usage))
      }
      throw error
    }
    return await this.ctx.admission.settle(
      run.runId,
      { kind: 'failed', summary: failureSummary, evidence: [truncateUtf8(errorMessage(error))] },
      usageSettlement(usage),
    )
  }
}

function activeExecution(): ActiveExecution {
  let complete: (() => void) | undefined
  const completion = new Promise<void>((resolve) => {
    complete = resolve
  })
  return {
    pauseRequested: false,
    completion,
    complete: () => complete?.(),
  }
}

function currentRun(snapshot: AdmissionSnapshot, runId: RunId): AutopilotRun {
  const run = snapshot.runs.find((candidate) => candidate.runId === runId)
  if (run === undefined) throw new Error(`run "${runId}" disappeared from the admission aggregate`)
  return run
}

function isPausedActive(run: AutopilotRun | undefined): run is PausedActiveRun {
  return run?.state === 'paused' && run.pause.kind === 'active'
}

function sameGit(left: GitExecutionSnapshot, right: GitExecutionSnapshot): boolean {
  return left.baseHead === right.baseHead && left.head === right.head && left.status === right.status
}

async function inspectRetainedWorktree(
  subprocess: SubprocessRuntime,
  run: PausedActiveRun,
): Promise<GitExecutionSnapshot> {
  const retainedGit = run.execution.git
  if (retainedGit === undefined) throw new Error('the retained run has no Git checkpoint')
  const observedRoot = await gitCommand(subprocess, run.execution.worktreePath, ['rev-parse', '--show-toplevel'])
  const observedBranch = await gitCommand(subprocess, run.execution.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const observedCommonDirectory = await gitCommand(subprocess, run.execution.worktreePath, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ])
  const targetCommonDirectory = await gitCommand(subprocess, run.execution.targetRepository, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ])
  const [canonicalRoot, canonicalWorktree, canonicalCommonDirectory, canonicalTargetCommonDirectory] =
    await Promise.all([
      realpath(observedRoot.trim()),
      realpath(run.execution.worktreePath),
      realpath(observedCommonDirectory.trim()),
      realpath(targetCommonDirectory.trim()),
    ])
  if (
    canonicalRoot !== canonicalWorktree ||
    canonicalCommonDirectory !== canonicalTargetCommonDirectory ||
    observedBranch.trim() !== run.execution.branch
  ) {
    throw new Error('the retained path is not the recorded managed Git worktree and branch')
  }
  return await inspectGit(subprocess, run.execution.worktreePath, retainedGit.baseHead)
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

function configureFixtureTools(agentCtx: Context): void {
  // This controlled execution profile cannot own or account for delegated descendants, so delegation fails closed.
  agentCtx.tools.restrict({ allow: [] })
}

function registerUsageRecorder(
  agentCtx: Context,
  run: ImplementingRun | PausingRun | PausedActiveRun,
  recorder: UsageRecorder,
): void {
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

function executionPrompt(run: ImplementingRun | PausingRun): string {
  const git = run.execution.git
  if (git === undefined) throw new Error('the managed worktree has no durable Git facts')
  return `Execute the approved Agent Brief below in the managed fixture worktree. Use autopilot_report exactly once with a verified, blocked, or failed outcome before finishing. A verified report must repeat the exact final Git head and porcelain status.\n\nManaged Git head: ${git.head}\nManaged Git status: ${JSON.stringify(git.status)}\n\n${run.brief.content}`
}

function continuationPrompt(run: ImplementingRun): string {
  const git = run.execution.git
  if (git === undefined) throw new Error('the managed worktree has no durable Git facts')
  return `Continue the approved Agent Brief in this same persisted Session and managed worktree. Reconcile any interrupted operation from the prior pause before repeating a side effect. Use autopilot_report exactly once with a verified, blocked, or failed outcome before finishing. A verified report must repeat the exact final Git head and porcelain status.\n\nManaged Git head: ${git.head}\nManaged Git status: ${JSON.stringify(git.status)}\n\n${run.brief.content}`
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
