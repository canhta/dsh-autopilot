import { createHash } from 'node:crypto'
import { SessionId as sessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import {
  readinessGeneration,
  trackerBindingId,
  trackerCommentId,
  trackerIssueId,
  trackerProviderId,
} from '../tracker.js'
import {
  ID_PATTERN,
  MAX_BRIEF_BYTES,
  MAX_INGRESS_RECEIPTS,
  MAX_OUTCOME_TEXT_BYTES,
  MAX_STATE_BYTES,
  MAX_SUMMARY_BYTES,
  type STATE_KEY,
  textEncoder,
} from './constants.js'
import type { AdmissionSnapshot, RunId } from './model.js'
import { boundedNonEmptyString, compareSnapshotRuns, isPausedActiveRun, runId, runIdentityFromRun } from './policy.js'

const briefSchema = z.object({
  commentId: z.string().min(1).max(256).transform(trackerCommentId),
  updatedAt: z.iso.datetime({ offset: true }),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  content: z.string().refine((value) => textEncoder.encode(value).byteLength <= MAX_BRIEF_BYTES, {
    error: `Brief content must not exceed ${String(MAX_BRIEF_BYTES)} UTF-8 bytes`,
  }),
})

export const runIdSchema = z
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

export const executionSchema = z.object({
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
export const outcomeSchema = z.discriminatedUnion('kind', [
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
  reason: z.enum(['operator', 'scheduler', 'service-withdrawal']),
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
export const schedulerModeSchema = z.enum(['enabled', 'draining', 'disabled'])
const schedulerSchema = z.object({
  mode: schedulerModeSchema,
  changedAt: z.iso.datetime({ offset: true }),
})

export const stateSchema = z
  .object({
    schemaVersion: z.literal(6),
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

export type AdmissionState = z.infer<typeof stateSchema>

export const admissionDomainSpec = defineDomain({
  name: 'autopilot_admission',
  version: 6,
  tables: {
    state: domainTable<typeof STATE_KEY, AdmissionState>(stateSchema),
  },
})

export function initialState(): AdmissionState {
  return {
    schemaVersion: 6,
    revision: 0,
    nextSequence: 1,
    runs: [],
    acceptedIngress: [],
    scheduler: { mode: 'enabled', changedAt: new Date().toISOString() },
    budget: { reservedTokens: 0, settledTokens: 0, usageUncertain: false },
  }
}

export function snapshotOf(state: AdmissionState): AdmissionSnapshot {
  return {
    revision: state.revision,
    runs: structuredClone(state.runs).sort(compareSnapshotRuns),
    acceptedIngress: [...state.acceptedIngress],
    scheduler: structuredClone(state.scheduler),
    budget: structuredClone(state.budget),
  }
}
