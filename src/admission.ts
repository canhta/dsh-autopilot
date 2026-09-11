import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { type Context, Service } from '@deepseek-ai/cordis'
import { type SessionId, SessionId as sessionId } from '@deepseek-ai/dsh-session'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import {
  type ReadinessGeneration,
  readinessGeneration,
  type TrackerBindingId,
  type TrackerComment,
  type TrackerCommentId,
  type TrackerIssueId,
  type TrackerIssueSnapshot,
  TrackerProviderError,
  type TrackerProviderId,
  type TrackerReader,
  trackerBindingId,
  trackerCommentId,
  trackerIssueId,
  trackerProviderId,
} from './tracker.js'

const MAX_INGRESS_RECEIPTS = 2048
const MAX_STATE_BYTES = 4 * 1024 * 1024
const MAX_SUMMARY_BYTES = 2048
const MAX_BRIEF_BYTES = 32 * 1024
const MAX_CANDIDATES = 1000
const MAX_CANDIDATE_BYTES = 16 * 1024 * 1024
const MAX_OUTCOME_TEXT_BYTES = 4 * 1024
const STATE_KEY = 'primary' as const
const textEncoder = new TextEncoder()
const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/

declare const runIdBrand: unique symbol
export type RunId = string & { readonly [runIdBrand]: true }

export type AdmissionSource = 'manual' | 'scheduled' | 'startup' | 'webhook'

export type SchedulerMode = 'enabled' | 'draining' | 'disabled'

export interface SchedulerSnapshot {
  readonly mode: SchedulerMode
  readonly changedAt: string
}

export interface ReconcileRequest {
  source: AdmissionSource
  deliveryId?: string
}

export type AdmissionRejectionReason =
  | 'missing-brief'
  | 'ambiguous-brief'
  | 'invalid-brief'
  | 'brief-too-large'
  | 'summary-too-large'
  | 'not-ready'
  | 'dependencies-incomplete'
  | 'dependency-unknown'
  | 'human-readiness-required'

export type AdmissionDecision =
  | { displayKey: string; outcome: 'queued' | 'duplicate' }
  | { displayKey: string; outcome: 'deferred'; reason: 'queue-capacity' }
  | { displayKey: string; outcome: 'rejected'; reason: AdmissionRejectionReason }

export interface AgentBriefSnapshot {
  readonly commentId: TrackerCommentId
  readonly updatedAt: string
  readonly digest: string
  readonly content: string
}

export interface QueuedRun {
  readonly runId: RunId
  readonly providerId: TrackerProviderId
  readonly bindingId: TrackerBindingId
  readonly issueId: TrackerIssueId
  readonly displayKey: string
  readonly summary: string
  readonly priorityRank: number
  readonly readinessGeneration: ReadinessGeneration
  readonly brief: AgentBriefSnapshot
  readonly state: 'queued'
  readonly queueClass: 'new' | 'resumption'
  readonly queuedAt: string
  readonly queueSequence: number
}

export interface PausedQueuedRun extends Omit<QueuedRun, 'state' | 'queueClass'> {
  readonly state: 'paused'
  readonly queueClass: 'resumption'
  readonly pause: {
    readonly kind: 'queued'
    readonly reason: 'operator'
    readonly operatorHold: true
    readonly continuationTarget: 'implementing'
    readonly pausedAt: string
  }
}

export type ActivePauseReason = 'operator' | 'scheduler'
export type ActiveResumeAuthorization = 'operator' | 'scheduler'

export interface ActivePauseSnapshot {
  readonly kind: 'active'
  readonly reason: ActivePauseReason
  readonly operatorHold: boolean
  readonly continuationTarget: 'implementing'
  readonly requestedAt: string
  readonly interruptedOperation: 'agent-turn'
}

export interface RunExecutionSnapshot {
  readonly attempt: number
  readonly sessionId: SessionId
  readonly targetRepository: string
  readonly baseBranch: string
  readonly worktreePath: string
  readonly branch: string
  readonly startedAt: string
  readonly git?: GitExecutionSnapshot | undefined
  readonly recovery?: RunRecoverySnapshot | undefined
}

export interface GitExecutionSnapshot {
  readonly baseHead: string
  readonly head: string
  readonly status: string
}

export interface RunRecoverySnapshot {
  readonly kind: 'required'
  readonly reason: 'host-restart' | 'session-unavailable' | 'workspace-unavailable' | 'worktree-mismatch'
  readonly interruptedAt: string
}

export type ActiveRecoveryReason = Exclude<RunRecoverySnapshot['reason'], 'host-restart'>

export interface RunBudgetSnapshot {
  readonly capTokens: number
  readonly allowanceTokens: number
  readonly reservedTokens: number
  readonly settledTokens: number
  readonly usageUncertain: boolean
  readonly usageUncertaintyReason?: string | undefined
}

export interface ImplementingRun extends Omit<QueuedRun, 'state'> {
  readonly state: 'implementing'
  readonly execution: RunExecutionSnapshot
  readonly budget: RunBudgetSnapshot
}

export interface PausingRun extends Omit<ImplementingRun, 'state'> {
  readonly state: 'pausing'
  readonly pause: ActivePauseSnapshot
}

export interface PausedActiveRun extends Omit<ImplementingRun, 'state'> {
  readonly state: 'paused'
  readonly pause: ActivePauseSnapshot & {
    readonly pausedAt: string
    readonly lastCompletedPhase: 'agent-quiescent'
  }
}

export type ExecutionOutcome =
  | {
      readonly kind: 'verified'
      readonly summary: string
      readonly evidence: string[]
      readonly reportedGit: Pick<GitExecutionSnapshot, 'head' | 'status'>
    }
  | { readonly kind: 'blocked'; readonly summary: string; readonly evidence: string[] }
  | { readonly kind: 'failed'; readonly summary: string; readonly evidence: string[] }

export interface TerminalRun extends Omit<QueuedRun, 'state'> {
  readonly state: 'publishing' | 'blocked' | 'failed'
  readonly execution: RunExecutionSnapshot
  readonly budget: RunBudgetSnapshot
  readonly outcome: ExecutionOutcome
  readonly completedAt: string
}

export type AutopilotRun = QueuedRun | PausedQueuedRun | ImplementingRun | PausingRun | PausedActiveRun | TerminalRun

export type RunUsageSettlement =
  | { readonly kind: 'known'; readonly tokens: number }
  | { readonly kind: 'uncertain'; readonly reason: string }

export interface AdmissionBudgetSnapshot {
  readonly reservedTokens: number
  readonly settledTokens: number
  readonly usageUncertain: boolean
}

export interface AdmissionSnapshot {
  revision: number
  runs: readonly AutopilotRun[]
  acceptedIngress: readonly string[]
  budget: AdmissionBudgetSnapshot
  scheduler: SchedulerSnapshot
}

export interface ReconcileResult extends AdmissionSnapshot {
  decisions: readonly AdmissionDecision[]
}

export interface SchedulerDisableResult {
  readonly snapshot: AdmissionSnapshot
  readonly pausingRunIds: readonly RunId[]
}

interface AdmissionSettings {
  trackerProvider: string
  maxQueued: number
  maxBriefBytes: number
  executionMode: 'disabled' | 'fixture'
  targetRepository: string
  targetBaseBranch: string
  managedWorktreeRoot: string
  deploymentTokenCap: number
  perRunTokenCap: number
  runTokenAllowance: number
}

const admissionSettingsSchema: s<AdmissionSettings> = s.object({
  trackerProvider: s.string().default('jira'),
  maxQueued: s.number().min(1).max(100).default(20),
  maxBriefBytes: s
    .number()
    .min(1024)
    .max(32 * 1024)
    .default(32 * 1024),
  executionMode: s.union(['disabled', 'fixture'] as const).default('disabled'),
  targetRepository: s.string().default(''),
  targetBaseBranch: s.string().default(''),
  managedWorktreeRoot: s.string().default(''),
  deploymentTokenCap: s.number().min(0).default(0),
  perRunTokenCap: s.number().min(0).default(0),
  runTokenAllowance: s.number().min(0).default(0),
})

const briefSchema = z.object({
  commentId: z.string().min(1).max(256).transform(trackerCommentId),
  updatedAt: z.iso.datetime({ offset: true }),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  content: z.string().refine((value) => textEncoder.encode(value).byteLength <= MAX_BRIEF_BYTES, {
    error: `Brief content must not exceed ${String(MAX_BRIEF_BYTES)} UTF-8 bytes`,
  }),
})

const runIdSchema = z
  .string()
  .regex(/^run_[a-f0-9]{32}$/)
  .transform((value) => value as RunId)

const runBaseSchema = z.object({
  runId: runIdSchema,
  providerId: z.string().transform(trackerProviderId),
  bindingId: z.string().transform(trackerBindingId),
  issueId: z.string().transform(trackerIssueId),
  displayKey: z.string().min(1).max(256),
  summary: z.string().refine((value) => textEncoder.encode(value).byteLength <= MAX_SUMMARY_BYTES, {
    error: `summary must not exceed ${String(MAX_SUMMARY_BYTES)} UTF-8 bytes`,
  }),
  priorityRank: z.number().int().nonnegative(),
  readinessGeneration: z.string().transform(readinessGeneration),
  brief: briefSchema,
  queueClass: z.enum(['new', 'resumption']),
  queuedAt: z.iso.datetime({ offset: true }),
  queueSequence: z.number().int().positive(),
})

const executionSchema = z.object({
  attempt: z.number().int().positive(),
  sessionId: z.string().min(1).max(256).transform(sessionId),
  targetRepository: z.string().min(1).max(4096),
  baseBranch: z.string().min(1).max(256),
  worktreePath: z.string().min(1).max(4096),
  branch: z.string().min(1).max(256),
  startedAt: z.iso.datetime({ offset: true }),
  git: z
    .object({
      baseHead: z.string().regex(/^[a-f0-9]{40,64}$/),
      head: z.string().regex(/^[a-f0-9]{40,64}$/),
      status: z.string().max(1024 * 1024),
    })
    .optional(),
  recovery: z
    .object({
      kind: z.literal('required'),
      reason: z.enum(['host-restart', 'session-unavailable', 'workspace-unavailable', 'worktree-mismatch']),
      interruptedAt: z.iso.datetime({ offset: true }),
    })
    .optional(),
})

const runBudgetSchema = z.object({
  capTokens: z.number().int().positive(),
  allowanceTokens: z.number().int().positive(),
  reservedTokens: z.number().int().nonnegative(),
  settledTokens: z.number().int().nonnegative(),
  usageUncertain: z.boolean(),
  usageUncertaintyReason: boundedNonEmptyString(MAX_OUTCOME_TEXT_BYTES, 'usage uncertainty reason').optional(),
})

const outcomeBaseSchema = z.object({
  summary: boundedNonEmptyString(MAX_OUTCOME_TEXT_BYTES, 'outcome summary'),
  evidence: z.array(boundedNonEmptyString(MAX_OUTCOME_TEXT_BYTES, 'outcome evidence')).max(100),
})
const outcomeSchema = z.discriminatedUnion('kind', [
  outcomeBaseSchema.extend({
    kind: z.literal('verified'),
    reportedGit: z.object({
      head: z.string().regex(/^[a-f0-9]{40,64}$/),
      status: z.string().max(1024 * 1024),
    }),
  }),
  outcomeBaseSchema.extend({ kind: z.literal('blocked') }),
  outcomeBaseSchema.extend({ kind: z.literal('failed') }),
])

const queuedRunSchema = runBaseSchema.extend({ state: z.literal('queued') })
const pausedQueuedRunSchema = runBaseSchema.extend({
  state: z.literal('paused'),
  queueClass: z.literal('resumption'),
  pause: z.object({
    kind: z.literal('queued'),
    reason: z.literal('operator'),
    operatorHold: z.literal(true),
    continuationTarget: z.literal('implementing'),
    pausedAt: z.iso.datetime({ offset: true }),
  }),
})
const implementingRunSchema = runBaseSchema.extend({
  state: z.literal('implementing'),
  execution: executionSchema,
  budget: runBudgetSchema,
})
const activePauseSchema = z.object({
  kind: z.literal('active'),
  reason: z.enum(['operator', 'scheduler']),
  operatorHold: z.boolean(),
  continuationTarget: z.literal('implementing'),
  requestedAt: z.iso.datetime({ offset: true }),
  pausedAt: z.iso.datetime({ offset: true }).optional(),
  lastCompletedPhase: z.literal('agent-quiescent').optional(),
  interruptedOperation: z.literal('agent-turn'),
})
const pausingRunSchema = runBaseSchema.extend({
  state: z.literal('pausing'),
  execution: executionSchema,
  budget: runBudgetSchema,
  pause: activePauseSchema.extend({
    pausedAt: z.undefined().optional(),
    lastCompletedPhase: z.undefined().optional(),
  }),
})
const pausedActiveRunSchema = runBaseSchema.extend({
  state: z.literal('paused'),
  execution: executionSchema,
  budget: runBudgetSchema,
  pause: activePauseSchema.extend({
    pausedAt: z.iso.datetime({ offset: true }),
    lastCompletedPhase: z.literal('agent-quiescent'),
  }),
})
const terminalRunSchema = runBaseSchema.extend({
  state: z.enum(['publishing', 'blocked', 'failed']),
  execution: executionSchema,
  budget: runBudgetSchema,
  outcome: outcomeSchema,
  completedAt: z.iso.datetime({ offset: true }),
})
const runSchema = z.union([
  queuedRunSchema,
  pausedQueuedRunSchema,
  implementingRunSchema,
  pausingRunSchema,
  pausedActiveRunSchema,
  terminalRunSchema,
])
const schedulerModeSchema = z.enum(['enabled', 'draining', 'disabled'])
const schedulerSchema = z.object({
  mode: schedulerModeSchema,
  changedAt: z.iso.datetime({ offset: true }),
})

const stateSchema = z
  .object({
    schemaVersion: z.literal(5),
    revision: z.number().int().nonnegative(),
    nextSequence: z.number().int().positive(),
    runs: z.array(runSchema).max(100),
    acceptedIngress: z.array(z.string().min(1).max(512).regex(ID_PATTERN)).max(MAX_INGRESS_RECEIPTS),
    scheduler: schedulerSchema,
    budget: z.object({
      reservedTokens: z.number().int().nonnegative(),
      settledTokens: z.number().int().nonnegative(),
      usageUncertain: z.boolean(),
    }),
  })
  .superRefine((value, context) => {
    const identities = value.runs.map(runIdentityFromRun)
    const sequences = value.runs.map((run) => run.queueSequence)
    const addIntegrityIssue = (message: string): void => {
      context.addIssue({ code: 'custom', message })
    }
    if (new Set(value.runs.map((run) => run.runId)).size !== value.runs.length) {
      addIntegrityIssue('run ids must be unique')
    }
    if (new Set(sequences).size !== sequences.length) addIntegrityIssue('queue sequences must be unique')
    if (new Set(value.acceptedIngress).size !== value.acceptedIngress.length) {
      addIntegrityIssue('accepted ingress ids must be unique')
    }
    if (value.runs.some((run, index) => run.runId !== runId(identities[index] ?? ''))) {
      addIntegrityIssue('run ids must match their durable identities')
    }
    if (value.runs.some((run) => createHash('sha256').update(run.brief.content).digest('hex') !== run.brief.digest)) {
      addIntegrityIssue('Brief digests must match retained content')
    }
    if (value.scheduler.mode === 'disabled' && value.runs.some((run) => run.state === 'implementing')) {
      addIntegrityIssue('disabled scheduler cannot retain an implementing run')
    }
    if (sequences.length > 0 && value.nextSequence <= Math.max(...sequences)) {
      addIntegrityIssue('next queue sequence must follow every retained run')
    }
    const runReservations = value.runs.reduce(
      (total, run) => total + ('budget' in run ? run.budget.reservedTokens : 0),
      0,
    )
    if (runReservations !== value.budget.reservedTokens) {
      addIntegrityIssue('deployment reservation must equal active run reservations')
    }
    const runSettlements = value.runs.reduce(
      (total, run) => total + ('budget' in run ? run.budget.settledTokens : 0),
      0,
    )
    if (runSettlements !== value.budget.settledTokens) {
      addIntegrityIssue('deployment settlement must equal retained run settlements')
    }
    const uncertain = value.runs.some((run) => 'budget' in run && run.budget.usageUncertain)
    if (uncertain !== value.budget.usageUncertain) {
      addIntegrityIssue('deployment usage uncertainty must match retained run uncertainty')
    }
    for (const run of value.runs) {
      if ('budget' in run && run.budget.usageUncertain !== (run.budget.usageUncertaintyReason !== undefined)) {
        addIntegrityIssue('run usage uncertainty must retain exactly one actionable reason')
      }
      if (
        (run.state === 'pausing' || isPausedActiveRun(run)) &&
        run.pause.operatorHold !== (run.pause.reason === 'operator')
      ) {
        addIntegrityIssue('active operator pause reason and hold must agree')
      }
      if ((run.state === 'implementing' || run.state === 'pausing') && run.budget.usageUncertain) {
        addIntegrityIssue('active runs cannot carry uncertain usage')
      }
      if ('budget' in run && run.budget.settledTokens + run.budget.reservedTokens > run.budget.capTokens) {
        addIntegrityIssue('run settled usage and reservation must stay within its retained cap')
      }
      if ('budget' in run && run.budget.reservedTokens > run.budget.allowanceTokens) {
        addIntegrityIssue('run reservation must stay within its immutable attempt allowance')
      }
      if (run.state === 'publishing' && run.outcome.kind !== 'verified') {
        addIntegrityIssue('publishing runs require a verified outcome')
      }
      if ((run.state === 'blocked' || run.state === 'failed') && run.outcome.kind !== run.state) {
        addIntegrityIssue('terminal lifecycle state must match its structured outcome')
      }
    }
  })
  .refine((value) => textEncoder.encode(JSON.stringify(value)).byteLength <= MAX_STATE_BYTES, {
    error: `admission state must not exceed ${String(MAX_STATE_BYTES)} UTF-8 bytes`,
  })

type AdmissionState = z.infer<typeof stateSchema>

const admissionDomainSpec = defineDomain({
  name: 'autopilot_admission',
  version: 5,
  tables: {
    state: domainTable<typeof STATE_KEY, AdmissionState>(stateSchema),
  },
})

interface EligibleIssue {
  issue: TrackerIssueSnapshot & { readiness: Extract<TrackerIssueSnapshot['readiness'], { kind: 'transition' }> }
  brief: AgentBriefSnapshot
}

function initialState(): AdmissionState {
  return {
    schemaVersion: 5,
    revision: 0,
    nextSequence: 1,
    runs: [],
    acceptedIngress: [],
    scheduler: { mode: 'enabled', changedAt: new Date().toISOString() },
    budget: { reservedTokens: 0, settledTokens: 0, usageUncertain: false },
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    admission: Admission
  }
}

export class Admission extends Service {
  static readonly inject = ['tracker', 'settings', 'storageDomain']

  private settings?: SettingsScope<AdmissionSettings>
  private state?: KvTable<typeof STATE_KEY, AdmissionState>

  constructor(ctx: Context) {
    super(ctx, 'admission')
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    this.settings = this.ctx.settings.register('dsh-autopilot', admissionSettingsSchema, {
      validate: (value) => {
        trackerProviderId(value.trackerProvider)
        if (
          !Number.isInteger(value.maxQueued) ||
          !Number.isInteger(value.maxBriefBytes) ||
          !Number.isInteger(value.deploymentTokenCap) ||
          !Number.isInteger(value.perRunTokenCap) ||
          !Number.isInteger(value.runTokenAllowance)
        ) {
          throw new TypeError('admission limits must be integers')
        }
        if (value.executionMode === 'fixture') validateFixtureExecutionSettings(value)
      },
    })
    const domain = await this.ctx.storageDomain.open(admissionDomainSpec)
    yield () => domain.close()
    this.state = domain.table('state')
    if (this.state.get(STATE_KEY) === undefined) {
      await this.state.put(STATE_KEY, initialState())
    } else {
      await this.markInterruptedRunsForRecovery()
    }
  }

  /**
   * Return a detached view with active work first, then queued work in dispatch order, then retained inactive runs.
   * Throws if the service has not finished initialization; it performs no I/O and has no cancellation point.
   */
  snapshot(): AdmissionSnapshot {
    const current = this.currentState()
    return snapshotOf(current)
  }

  /**
   * Atomically persist the scheduler admission/claim gate and return a detached aggregate snapshot. Draining permits
   * implementing runs to settle; disabling rejects while any run is implementing. Invalid input or durable-write
   * failure leaves the previous mode unchanged. The command accepts no caller cancellation signal.
   */
  async setSchedulerMode(mode: SchedulerMode): Promise<AdmissionSnapshot> {
    const parsedMode = schedulerModeSchema.parse(mode)
    const committed = await this.currentTable().update(STATE_KEY, (current) => {
      if (parsedMode === 'disabled' && current.runs.some((run) => run.state === 'implementing')) {
        throw new Error('scheduler cannot be disabled while an implementing run exists')
      }
      if (parsedMode === 'enabled' && current.runs.some((run) => run.state === 'pausing')) {
        throw new Error('scheduler cannot be enabled while a run is still pausing')
      }
      if (current.scheduler.mode === parsedMode) return current
      const next = structuredClone(current)
      next.scheduler = { mode: parsedMode, changedAt: new Date().toISOString() }
      next.revision += 1
      return stateSchema.parse(next)
    })
    return snapshotOf(committed)
  }

  /**
   * Atomically disable admission/dequeue and move every implementing run to `pausing`. The returned run ids identify
   * live executions whose owner must request cancellation and checkpoint only after quiescence. Existing pause requests
   * retain their operator-hold intent. Durable-write failure leaves both scheduler and runs unchanged. This operation
   * requests lifecycle work but does not itself own or cancel an Agent.
   */
  async requestSchedulerDisable(): Promise<SchedulerDisableResult> {
    let pausingRunIds: RunId[] = []
    const committed = await this.currentTable().update(STATE_KEY, (current) => {
      const requestedAt = new Date().toISOString()
      const next = structuredClone(current)
      next.scheduler = { mode: 'disabled', changedAt: requestedAt }
      next.runs = next.runs.map((run) =>
        run.state === 'implementing'
          ? {
              ...run,
              state: 'pausing' as const,
              pause: activePause('scheduler', requestedAt),
            }
          : run,
      )
      pausingRunIds = next.runs.filter((run): run is PausingRun => run.state === 'pausing').map((run) => run.runId)
      if (current.scheduler.mode === 'disabled' && !current.runs.some((run) => run.state === 'implementing')) {
        return current
      }
      next.revision += 1
      return stateSchema.parse(next)
    })
    return { snapshot: snapshotOf(committed), pausingRunIds: [...pausingRunIds] }
  }

  /**
   * Atomically request an operator pause for one allocated run. An implementing run becomes `pausing`; an existing
   * scheduler pause is upgraded to an operator hold without losing its original checkpoint facts. Queued runs use
   * `holdQueued` instead. The request owns no Agent cancellation and accepts no caller cancellation signal.
   */
  async requestRunPause(runId: RunId): Promise<PausingRun | PausedActiveRun> {
    const parsedRunId = runIdSchema.parse(runId)
    let requested: PausingRun | PausedActiveRun | undefined
    await this.currentTable().update(STATE_KEY, (current) => {
      const index = current.runs.findIndex((run) => run.runId === parsedRunId)
      const run = current.runs[index]
      if (run === undefined) throw new Error(`run "${parsedRunId}" does not exist`)
      if (isPausedActiveRun(run) && run.pause.operatorHold) {
        requested = structuredClone(run)
        return current
      }

      const next = structuredClone(current)
      let nextRun: PausingRun | PausedActiveRun
      if (run.state === 'implementing') {
        nextRun = { ...run, state: 'pausing', pause: activePause('operator', new Date().toISOString()) }
      } else if (run.state === 'pausing') {
        nextRun = {
          ...run,
          pause: { ...run.pause, reason: 'operator', operatorHold: true },
        }
      } else if (isPausedActiveRun(run)) {
        nextRun = {
          ...run,
          pause: { ...run.pause, reason: 'operator', operatorHold: true },
        }
      } else {
        throw new Error(`run "${parsedRunId}" is not an allocated active or paused run`)
      }
      requested = nextRun
      next.runs[index] = nextRun
      next.revision += 1
      return stateSchema.parse(next)
    })
    if (requested === undefined) throw new Error(`run "${parsedRunId}" pause was not requested`)
    return structuredClone(requested)
  }

  /**
   * Commit a pause only after the execution owner has proven its root idle, flushed the Session, and inspected Git.
   * Known usage releases the reservation and advances settled usage. Missing, malformed, or excessive usage retains the
   * reservation and marks deployment usage uncertain for later reconciliation. A lost pause race or write failure leaves
   * the `pausing` checkpoint unchanged. The method accepts no caller cancellation signal.
   */
  async checkpointPaused(runId: RunId, git: GitExecutionSnapshot, usage: RunUsageSettlement): Promise<PausedActiveRun> {
    const parsedRunId = runIdSchema.parse(runId)
    const parsedGit = executionSchema.shape.git.unwrap().parse(git)
    let paused: PausedActiveRun | undefined
    await this.currentTable().update(STATE_KEY, (current) => {
      const next = structuredClone(current)
      const index = next.runs.findIndex((run) => run.runId === parsedRunId)
      const run = next.runs[index]
      if (run?.state !== 'pausing') throw new Error(`run "${parsedRunId}" is not pausing`)
      const usageKnown = validUsageSettlement(run, usage)
      const pausedAt = new Date().toISOString()
      paused = {
        ...run,
        state: 'paused',
        execution: { ...run.execution, git: parsedGit },
        budget: {
          ...run.budget,
          reservedTokens: usageKnown ? 0 : run.budget.reservedTokens,
          settledTokens: usageKnown ? run.budget.settledTokens + usage.tokens : run.budget.settledTokens,
          usageUncertain: !usageKnown,
          ...(usageKnown ? {} : { usageUncertaintyReason: usageUncertaintyReason(run, usage) }),
        },
        pause: { ...run.pause, pausedAt, lastCompletedPhase: 'agent-quiescent' },
      }
      next.runs[index] = paused
      if (usageKnown) {
        next.budget.reservedTokens -= run.budget.reservedTokens
        next.budget.settledTokens += usage.tokens
      } else {
        next.budget.usageUncertain = true
      }
      next.revision += 1
      return stateSchema.parse(next)
    })
    if (paused === undefined) throw new Error(`run "${parsedRunId}" pause checkpoint was not recorded`)
    return structuredClone(paused)
  }

  /**
   * Atomically place one queued run on a durable operator hold before Session or worktree allocation.
   * The run must exist and still be queued. Invalid input, a different lifecycle state, or durable-write failure leaves
   * the run unchanged. The returned paused run is detached; this operation has no external effects or cancellation point.
   */
  async holdQueued(runId: RunId): Promise<PausedQueuedRun> {
    const parsedRunId = runIdSchema.parse(runId)
    let held: PausedQueuedRun | undefined
    await this.currentTable().update(STATE_KEY, (current) => {
      const index = current.runs.findIndex((run) => run.runId === parsedRunId)
      const run = current.runs[index]
      if (run === undefined) throw new Error(`run "${parsedRunId}" does not exist`)
      if (run.state !== 'queued') throw new Error(`run "${parsedRunId}" is not queued`)

      held = {
        ...structuredClone(run),
        state: 'paused',
        queueClass: 'resumption',
        pause: {
          kind: 'queued',
          reason: 'operator',
          operatorHold: true,
          continuationTarget: 'implementing',
          pausedAt: new Date().toISOString(),
        },
      }
      const next = structuredClone(current)
      next.runs[index] = held
      next.revision += 1
      return stateSchema.parse(next)
    })
    if (held === undefined) throw new Error(`run "${parsedRunId}" was not held`)
    return structuredClone(held)
  }

  /**
   * Revalidate an operator-held queued run against the current tracker issue and return it to the resumption queue.
   * Requires an enabled scheduler, certain deployment usage, the selected tracker provider, one currently eligible issue,
   * and an unchanged readiness generation and Agent Brief. Provider/read/validation failures or a concurrent durable
   * state change preserve the hold. Success clears only the hold, keeps the run identity, and allocates no Session or
   * worktree. Provider withdrawal owns cancellation of its read; callers cannot independently cancel this operation.
   */
  async resumeRun(runId: RunId): Promise<QueuedRun> {
    const parsedRunId = runIdSchema.parse(runId)
    const settings = this.currentSettings()
    const providerId = trackerProviderId(settings.trackerProvider)
    const beforeRead = this.currentState()
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

    return this.ctx.tracker.withProvider(providerId, async (reader) => {
      const candidates = await this.readEveryCandidate(reader, providerId)
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
      await this.currentTable().update(STATE_KEY, (current) => {
        if (current.scheduler.mode !== 'enabled') {
          throw new Error('scheduler must be enabled to resume a run')
        }
        if (current.budget.usageUncertain) {
          throw new Error('deployment token usage is uncertain; reconcile it before resuming')
        }
        const currentSettings = this.currentSettings()
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
    const settings = this.currentSettings()
    validateFixtureExecutionSettings(settings)
    const providerId = trackerProviderId(settings.trackerProvider)
    const beforeRead = this.currentState()
    if (beforeRead.scheduler.mode !== 'enabled') throw new Error('scheduler must be enabled to resume a run')
    if (beforeRead.budget.usageUncertain) {
      throw new Error('deployment token usage is uncertain; reconcile it before resuming')
    }
    const retained = beforeRead.runs.find((run) => run.runId === parsedRunId)
    if (!isPausedActiveRun(retained)) throw new Error(`run "${parsedRunId}" is not an allocated paused run`)
    validateActiveResumeFacts(retained, parsedGit, settings, authorization)

    return this.ctx.tracker.withProvider(providerId, async (reader) => {
      const candidates = await this.readEveryCandidate(reader, providerId)
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
      await this.currentTable().update(STATE_KEY, (current) => {
        const currentSettings = this.currentSettings()
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
      .enum(['session-unavailable', 'workspace-unavailable', 'worktree-mismatch'])
      .parse(reason) as ActiveRecoveryReason
    let recovery: PausedActiveRun | undefined
    await this.currentTable().update(STATE_KEY, (current) => {
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

  /**
   * Atomically claim the highest-priority queued run and reserve its configured fixture allowance.
   * Returns undefined when the scheduler is not enabled or the queue is empty. Otherwise, explicit fixture execution
   * paths and positive caps are required. The claim stores immutable run/Session/worktree identities and its reservation
   * together; disabled execution, uncertain usage, insufficient capacity, invalid configuration, or durable-write
   * failure rejects without a partial claim. The method accepts no cancellation signal and does not start external work.
   */
  async claimNext(): Promise<ImplementingRun | undefined> {
    const settings = this.currentSettings()
    let claimed: ImplementingRun | undefined
    await this.currentTable().update(STATE_KEY, (current) => {
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
    await this.currentTable().update(STATE_KEY, (current) => {
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
    await this.currentTable().update(STATE_KEY, (current) => {
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

  /**
   * Read the selected tracker provider and atomically admit every currently eligible issue.
   * When the scheduler is not enabled, returns an unchanged detached snapshot without reading the provider or retaining
   * an ingress receipt. Provider, validation, capacity, or durable-write failures reject without advancing admission
   * state. Provider withdrawal cancels its owned reads; callers cannot independently cancel this operation in interface
   * version 1.
   */
  async reconcile(request: ReconcileRequest): Promise<ReconcileResult> {
    validateRequest(request)
    const settings = this.currentSettings()
    const providerId = trackerProviderId(settings.trackerProvider)
    if (request.deliveryId !== undefined && !request.deliveryId.startsWith(`${providerId}:`)) {
      throw new TypeError(`delivery id must be qualified by tracker provider "${providerId}"`)
    }
    const beforeRead = this.currentState()
    if (beforeRead.scheduler.mode !== 'enabled') {
      return { ...snapshotOf(beforeRead), decisions: [] }
    }
    if (request.deliveryId !== undefined && beforeRead.acceptedIngress.includes(request.deliveryId)) {
      return { ...snapshotOf(beforeRead), decisions: [] }
    }
    return this.ctx.tracker.withProvider(providerId, async (reader) => {
      const candidates = await this.readEveryCandidate(reader, providerId)
      const evaluated = candidates.map((issue) => evaluateIssue(issue, settings.maxBriefBytes))
      const eligible = evaluated
        .map((evaluation, index) => ({ evaluation, index }))
        .filter((entry): entry is { evaluation: EligibleIssue; index: number } => !('reason' in entry.evaluation))
        .sort(
          (left, right) =>
            left.evaluation.issue.priorityRank - right.evaluation.issue.priorityRank ||
            runIdentity(providerId, left.evaluation.issue).localeCompare(
              runIdentity(providerId, right.evaluation.issue),
            ),
        )
      const state = this.currentTable()
      let decisions: AdmissionDecision[] = []
      const committed = await state.update(STATE_KEY, (current) => {
        if (current.scheduler.mode !== 'enabled') {
          decisions = []
          return current
        }
        if (request.deliveryId !== undefined && current.acceptedIngress.includes(request.deliveryId)) {
          decisions = []
          return current
        }
        const next = structuredClone(current)
        const indexedDecisions: Array<AdmissionDecision | undefined> = evaluated.map((evaluation) => {
          if ('reason' in evaluation) {
            return { displayKey: evaluation.displayKey, outcome: 'rejected', reason: evaluation.reason }
          }
          return undefined
        })
        for (const { evaluation, index } of eligible) {
          const issue = evaluation.issue
          const identity = runIdentity(providerId, issue)
          if (next.runs.some((run) => runIdentityFromRun(run) === identity)) {
            indexedDecisions[index] = { displayKey: issue.displayKey, outcome: 'duplicate' }
            continue
          }
          if (next.runs.length >= settings.maxQueued) {
            indexedDecisions[index] = {
              displayKey: issue.displayKey,
              outcome: 'deferred',
              reason: 'queue-capacity',
            }
            continue
          }

          const run: QueuedRun = {
            runId: runId(identity),
            providerId,
            bindingId: issue.bindingId,
            issueId: issue.issueId,
            displayKey: issue.displayKey,
            summary: issue.summary,
            priorityRank: issue.priorityRank,
            readinessGeneration: issue.readiness.generation,
            brief: evaluation.brief,
            state: 'queued',
            queueClass: 'new',
            queuedAt: new Date().toISOString(),
            queueSequence: next.nextSequence,
          }
          next.runs.push(run)
          next.nextSequence += 1
          indexedDecisions[index] = { displayKey: issue.displayKey, outcome: 'queued' }
        }
        decisions = indexedDecisions.filter((decision) => decision !== undefined)

        if (request.deliveryId !== undefined) {
          next.acceptedIngress.push(request.deliveryId)
          if (next.acceptedIngress.length > MAX_INGRESS_RECEIPTS) next.acceptedIngress.shift()
        }
        next.revision += 1
        const parsed = stateSchema.parse(next)
        assertStateSize(parsed)
        return parsed
      })

      return { ...snapshotOf(committed), decisions }
    })
  }

  private async readEveryCandidate(
    reader: TrackerReader,
    providerId: TrackerProviderId,
  ): Promise<TrackerIssueSnapshot[]> {
    const issues: TrackerIssueSnapshot[] = []
    const seenCursors = new Set<string>()
    let totalCandidateBytes = 0
    let cursor: string | undefined
    do {
      const page = await reader.readCandidates(cursor)
      const retainedBytes = textEncoder.encode(JSON.stringify(page)).byteLength
      totalCandidateBytes += retainedBytes
      if (issues.length + page.issues.length > MAX_CANDIDATES || totalCandidateBytes > MAX_CANDIDATE_BYTES) {
        throw new TrackerProviderError('invalid-response', `tracker provider "${providerId}" exceeded admission bounds`)
      }
      issues.push(...page.issues)
      cursor = page.nextCursor
      if (cursor !== undefined && (!seenCursors.add(cursor) || seenCursors.size > 1000)) {
        throw new Error(`tracker provider "${providerId}" returned a non-terminating cursor sequence`)
      }
    } while (cursor !== undefined)
    return issues
  }

  private currentSettings(): AdmissionSettings {
    if (this.settings === undefined) throw new Error('admission service is not initialized')
    return this.settings.get()
  }

  private currentTable(): KvTable<typeof STATE_KEY, AdmissionState> {
    if (this.state === undefined) throw new Error('admission service is not initialized')
    return this.state
  }

  private currentState(): AdmissionState {
    const current = this.currentTable().get(STATE_KEY)
    if (current === undefined) throw new Error('admission state record is missing')
    return current
  }

  private async markInterruptedRunsForRecovery(): Promise<void> {
    await this.currentTable().update(STATE_KEY, (current) => {
      if (
        !current.runs.some(
          (run) => (run.state === 'implementing' || run.state === 'pausing') && run.execution.recovery === undefined,
        )
      ) {
        return current
      }
      const interruptedAt = new Date().toISOString()
      const next = structuredClone(current)
      next.runs = next.runs.map((run) =>
        (run.state === 'implementing' || run.state === 'pausing') && run.execution.recovery === undefined
          ? {
              ...run,
              execution: {
                ...run.execution,
                recovery: { kind: 'required', reason: 'host-restart', interruptedAt },
              },
            }
          : run,
      )
      next.revision += 1
      return stateSchema.parse(next)
    })
  }
}

function activePause(reason: ActivePauseReason, requestedAt: string): ActivePauseSnapshot {
  return {
    kind: 'active',
    reason,
    operatorHold: reason === 'operator',
    continuationTarget: 'implementing',
    requestedAt,
    interruptedOperation: 'agent-turn',
  }
}

function isPausedActiveRun(run: AutopilotRun | undefined): run is PausedActiveRun {
  return run?.state === 'paused' && run.pause.kind === 'active'
}

function isPausedQueuedRun(run: AutopilotRun | undefined): run is PausedQueuedRun {
  return run?.state === 'paused' && run.pause.kind === 'queued'
}

function validUsageSettlement(
  run: ImplementingRun | PausingRun,
  usage: RunUsageSettlement,
): usage is Extract<RunUsageSettlement, { kind: 'known' }> {
  return (
    usage.kind === 'known' &&
    Number.isSafeInteger(usage.tokens) &&
    usage.tokens >= 0 &&
    usage.tokens <= run.budget.reservedTokens &&
    run.budget.settledTokens + usage.tokens <= run.budget.capTokens
  )
}

function usageUncertaintyReason(run: ImplementingRun | PausingRun, usage: RunUsageSettlement): string {
  return usage.kind === 'uncertain'
    ? truncateUtf8(usage.reason, MAX_OUTCOME_TEXT_BYTES) || 'provider did not supply a usage uncertainty reason'
    : `reported usage exceeded the reserved allowance of ${String(run.budget.reservedTokens)} tokens`
}

function validateActiveResumeFacts(
  run: PausedActiveRun,
  observedGit: GitExecutionSnapshot,
  settings: AdmissionSettings,
  authorization: ActiveResumeAuthorization,
): void {
  if (authorization !== 'operator' && authorization !== 'scheduler') {
    throw new TypeError('active resume authorization must be operator or scheduler')
  }
  if (authorization === 'scheduler' && run.pause.operatorHold) {
    throw new Error(`run "${run.runId}" requires explicit operator resume`)
  }
  if (run.execution.recovery !== undefined) throw new Error(`run "${run.runId}" requires explicit recovery`)
  if (run.budget.usageUncertain) throw new Error(`run "${run.runId}" has uncertain token usage`)
  if (run.budget.settledTokens >= run.budget.capTokens) {
    throw new Error(`run "${run.runId}" has no retained token capacity`)
  }
  if (
    run.execution.targetRepository !== settings.targetRepository ||
    run.execution.baseBranch !== settings.targetBaseBranch ||
    run.execution.worktreePath !== join(settings.managedWorktreeRoot, run.runId)
  ) {
    throw new Error(`run "${run.runId}" retained execution routing no longer matches current policy`)
  }
  const retainedGit = run.execution.git
  if (
    retainedGit === undefined ||
    retainedGit.baseHead !== observedGit.baseHead ||
    retainedGit.head !== observedGit.head ||
    retainedGit.status !== observedGit.status
  ) {
    throw new Error(`run "${run.runId}" retained Git state changed and requires explicit recovery`)
  }
}

function evaluateIssue(
  issue: TrackerIssueSnapshot,
  maxBriefBytes: number,
): EligibleIssue | { displayKey: string; reason: AdmissionRejectionReason } {
  if (textEncoder.encode(issue.summary).byteLength > MAX_SUMMARY_BYTES) {
    return { displayKey: issue.displayKey, reason: 'summary-too-large' }
  }
  if (!issue.isReady) return { displayKey: issue.displayKey, reason: 'not-ready' }
  const designated = issue.comments.filter(isDesignatedBrief)
  if (designated.length === 0) return { displayKey: issue.displayKey, reason: 'missing-brief' }
  if (designated.length > 1) return { displayKey: issue.displayKey, reason: 'ambiguous-brief' }
  const comment = designated[0]
  if (comment === undefined) return { displayKey: issue.displayKey, reason: 'missing-brief' }
  if (textEncoder.encode(comment.body).byteLength > maxBriefBytes) {
    return { displayKey: issue.displayKey, reason: 'brief-too-large' }
  }
  if (!hasRequiredBriefSections(comment.body)) {
    return { displayKey: issue.displayKey, reason: 'invalid-brief' }
  }
  if (issue.dependencies.some((dependency) => dependency.state === 'unknown')) {
    return { displayKey: issue.displayKey, reason: 'dependency-unknown' }
  }
  if (issue.dependencies.some((dependency) => dependency.state === 'not-completed')) {
    return { displayKey: issue.displayKey, reason: 'dependencies-incomplete' }
  }
  if (issue.readiness.kind !== 'transition' || issue.readiness.actorKind !== 'human') {
    return { displayKey: issue.displayKey, reason: 'human-readiness-required' }
  }
  if (Date.parse(issue.readiness.occurredAt) < Date.parse(comment.updatedAt)) {
    return { displayKey: issue.displayKey, reason: 'human-readiness-required' }
  }
  return {
    issue: issue as EligibleIssue['issue'],
    brief: {
      commentId: comment.id,
      updatedAt: comment.updatedAt,
      digest: createHash('sha256').update(comment.body).digest('hex'),
      content: comment.body,
    },
  }
}

function isDesignatedBrief(comment: TrackerComment): boolean {
  return /^#\s+Agent Brief\s*$/im.test(comment.body) && /^dsh-autopilot:brief:v1\s*$/im.test(comment.body)
}

function hasRequiredBriefSections(body: string): boolean {
  const matches = [...body.matchAll(/^##\s+(.+?)\s*$/gm)]
  const sections = new Map<string, string>()
  for (const [index, match] of matches.entries()) {
    const rawHeading = match[1]
    if (rawHeading === undefined || match.index === undefined) return false
    const heading = rawHeading.trim().toLocaleLowerCase('en-US')
    const contentStart = match.index + match[0].length
    const contentEnd = matches[index + 1]?.index ?? body.length
    sections.set(heading, body.slice(contentStart, contentEnd).trim())
  }
  return ['objective', 'in scope', 'acceptance criteria', 'constraints', 'context'].every(
    (heading) => (sections.get(heading)?.length ?? 0) > 0,
  )
}

function runIdentity(providerId: TrackerProviderId, issue: EligibleIssue['issue']): string {
  if (issue.readiness.kind !== 'transition') throw new Error('eligible issue lost readiness transition')
  return JSON.stringify([providerId, issue.bindingId, issue.issueId, issue.readiness.generation])
}

function runIdentityFromRun(
  run: Pick<AutopilotRun, 'providerId' | 'bindingId' | 'issueId' | 'readinessGeneration'>,
): string {
  return JSON.stringify([run.providerId, run.bindingId, run.issueId, run.readinessGeneration])
}

function matchesRetainedIssue(
  run: Pick<AutopilotRun, 'providerId' | 'bindingId' | 'issueId' | 'readinessGeneration' | 'brief'>,
  providerId: TrackerProviderId,
  evaluation: EligibleIssue,
): boolean {
  return (
    run.providerId === providerId &&
    run.bindingId === evaluation.issue.bindingId &&
    run.issueId === evaluation.issue.issueId &&
    run.readinessGeneration === evaluation.issue.readiness.generation &&
    sameBrief(run.brief, evaluation.brief)
  )
}

function sameRetainedRun(current: PausedQueuedRun, expected: PausedQueuedRun): boolean {
  return (
    current.runId === expected.runId &&
    runIdentityFromRun(current) === runIdentityFromRun(expected) &&
    sameBrief(current.brief, expected.brief)
  )
}

function sameBrief(left: AgentBriefSnapshot, right: AgentBriefSnapshot): boolean {
  return (
    left.commentId === right.commentId &&
    left.updatedAt === right.updatedAt &&
    left.digest === right.digest &&
    left.content === right.content
  )
}

function runId(identity: string): RunId {
  return `run_${createHash('sha256').update(identity).digest('hex').slice(0, 32)}` as RunId
}

function queueClassRank(queueClass: QueuedRun['queueClass']): number {
  return queueClass === 'resumption' ? 0 : 1
}

function compareQueuedRuns(left: QueuedRun, right: QueuedRun): number {
  return queueClassRank(left.queueClass) - queueClassRank(right.queueClass) || compareRunFacts(left, right)
}

function compareSnapshotRuns(left: AutopilotRun, right: AutopilotRun): number {
  return snapshotGroup(left) - snapshotGroup(right) || compareRunFacts(left, right)
}

function snapshotGroup(run: AutopilotRun): number {
  if (run.state === 'implementing' || run.state === 'pausing') return 0
  if (run.state === 'queued') return queueClassRank(run.queueClass) + 1
  return 3
}

function compareRunFacts(left: AutopilotRun, right: AutopilotRun): number {
  return (
    left.priorityRank - right.priorityRank ||
    left.queueSequence - right.queueSequence ||
    left.displayKey.localeCompare(right.displayKey)
  )
}

function executionFor(run: QueuedRun, settings: AdmissionSettings): RunExecutionSnapshot {
  const stableId = run.runId.slice('run_'.length)
  return {
    attempt: 1,
    sessionId: sessionId(`autopilot-${run.runId}`),
    targetRepository: settings.targetRepository,
    baseBranch: settings.targetBaseBranch,
    worktreePath: join(settings.managedWorktreeRoot, run.runId),
    branch: `dsh-autopilot/${stableId}`,
    startedAt: new Date().toISOString(),
  }
}

function snapshotOf(state: AdmissionState): AdmissionSnapshot {
  return {
    revision: state.revision,
    runs: structuredClone(state.runs).sort(compareSnapshotRuns),
    acceptedIngress: [...state.acceptedIngress],
    scheduler: structuredClone(state.scheduler),
    budget: structuredClone(state.budget),
  }
}

function validateFixtureExecutionSettings(settings: AdmissionSettings): void {
  if (settings.executionMode !== 'fixture') {
    throw new Error('dispatch is disabled; this slice accepts only explicit fixture execution')
  }
  if (!isAbsolute(settings.targetRepository) || !isAbsolute(settings.managedWorktreeRoot)) {
    throw new TypeError('fixture target repository and managed worktree root must be absolute paths')
  }
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(settings.targetBaseBranch) ||
    settings.targetBaseBranch.includes('..') ||
    settings.targetBaseBranch.includes('//') ||
    settings.targetBaseBranch.endsWith('/') ||
    settings.targetBaseBranch.endsWith('.lock')
  ) {
    throw new TypeError('fixture target base branch is invalid')
  }
  for (const [name, value] of [
    ['deploymentTokenCap', settings.deploymentTokenCap],
    ['perRunTokenCap', settings.perRunTokenCap],
    ['runTokenAllowance', settings.runTokenAllowance],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`)
  }
  if (settings.runTokenAllowance > settings.perRunTokenCap) {
    throw new TypeError('run token allowance must not exceed the per-run token cap')
  }
  if (settings.runTokenAllowance > settings.deploymentTokenCap) {
    throw new TypeError('run token allowance must not exceed the deployment token cap')
  }
}

function assertStateSize(state: AdmissionState): void {
  if (textEncoder.encode(JSON.stringify(state)).byteLength > MAX_STATE_BYTES) {
    throw new RangeError(`admission state exceeds ${String(MAX_STATE_BYTES)} bytes`)
  }
}

function boundedNonEmptyString(maxBytes: number, label: string): z.ZodString {
  return z
    .string()
    .min(1)
    .refine((value) => textEncoder.encode(value).byteLength <= maxBytes, {
      error: `${label} must not exceed ${String(maxBytes)} UTF-8 bytes`,
    })
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (textEncoder.encode(value).byteLength <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (textEncoder.encode(value.slice(0, middle)).byteLength <= maxBytes) low = middle
    else high = middle - 1
  }
  return value.slice(0, low)
}

function validateRequest(request: ReconcileRequest): void {
  if (!['manual', 'scheduled', 'startup', 'webhook'].includes(request.source)) {
    throw new TypeError(`unsupported admission source "${String(request.source)}"`)
  }
  if (request.source === 'webhook' && request.deliveryId === undefined) {
    throw new TypeError('webhook reconciliation requires a provider-qualified delivery id')
  }
  if (request.deliveryId !== undefined && (request.deliveryId.length > 512 || !ID_PATTERN.test(request.deliveryId))) {
    throw new TypeError('delivery id must be provider-qualified and contain only stable id characters')
  }
}

export default Admission
