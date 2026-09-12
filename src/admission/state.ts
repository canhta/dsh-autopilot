import { SessionId as sessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { codeHostBindingId, codeHostProviderId, codeHostRepositoryId, pullRequestId } from '../code-host.js'
import { notificationDestinationId, notificationProviderId } from '../notification.js'
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
  MAX_OPERATOR_COMMANDS,
  MAX_OUTCOME_TEXT_BYTES,
  MAX_STATE_BYTES,
  MAX_SUMMARY_BYTES,
  textEncoder,
} from './constants.js'
import type { RunId } from './model.js'
import { boundedNonEmptyString } from './policy.js'
import { validateStateIntegrity } from './state-integrity.js'

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

export const operatorCommandKindSchema = z.enum([
  'pause-scheduler',
  'resume-scheduler',
  'drain',
  'reconcile',
  'pause-run',
  'resume-run',
  'cancel-run',
  'retry-delivery',
  'remove-worktree',
])
export type OperatorCommandKind = z.infer<typeof operatorCommandKindSchema>

export const operatorCommandSchema = z.object({
  requestId: z.string().uuid(),
  kind: operatorCommandKindSchema,
  runId: runIdSchema.optional(),
  deliveryId: z.string().min(1).max(512).optional(),
  previewId: z.string().uuid().optional(),
  status: z.enum(['accepted', 'in-progress', 'succeeded', 'rejected']),
  acceptedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).optional(),
  message: z.string().max(500).optional(),
  revision: z.number().int().nonnegative().optional(),
})
export type OperatorCommandRecord = z.infer<typeof operatorCommandSchema>

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
  deliveries: z.array(z.lazy(() => deliverySchema)).max(64),
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
  agent: z
    .object({
      presetId: z.string().min(1).max(256),
      presetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      permission: z.object({
        presetId: z.string().min(1).max(256),
        sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
        approval: z.literal('never'),
      }),
      model: z.object({
        provider: z.string().min(1).max(256),
        model: z.string().min(1).max(512),
        reasoningEffort: z.string().min(1).max(128).optional(),
      }),
    })
    .optional(),
  codeHost: z.object({
    providerId: z.string().transform(codeHostProviderId),
    bindingId: z.string().transform(codeHostBindingId),
    repositoryId: z.string().transform(codeHostRepositoryId),
    repository: z.string().min(1).max(512),
    allowWorkflowChanges: z.boolean(),
  }),
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
      reason: z.enum([
        'host-restart',
        'composition-unavailable',
        'session-unavailable',
        'workspace-unavailable',
        'worktree-mismatch',
      ]),
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
const verificationResultSchema = z
  .object({
    command: boundedNonEmptyString(MAX_OUTCOME_TEXT_BYTES, 'verification command'),
    status: z.enum(['passed', 'failed', 'skipped']),
    summary: boundedNonEmptyString(MAX_OUTCOME_TEXT_BYTES, 'verification summary'),
    reason: boundedNonEmptyString(MAX_OUTCOME_TEXT_BYTES, 'verification reason').optional(),
  })
  .superRefine((value, context) => {
    if ((value.status === 'skipped') !== (value.reason !== undefined)) {
      context.addIssue({ code: 'custom', message: 'only skipped verification requires a reason' })
    }
  })
const blockedOutcomeSchema = outcomeBaseSchema.extend({ kind: z.literal('blocked') })
export const outcomeSchema = z.discriminatedUnion('kind', [
  outcomeBaseSchema.extend({
    kind: z.literal('verified'),
    reportedGit: z.object({
      head: z.string().regex(/^[a-f0-9]{40,64}$/),
      status: z.string().max(1024 * 1024),
    }),
    verification: z.array(verificationResultSchema).min(1).max(100),
    suggestedPullRequest: z.object({
      title: boundedNonEmptyString(MAX_OUTCOME_TEXT_BYTES, 'pull-request title'),
      body: boundedNonEmptyString(32 * 1024, 'pull-request body'),
    }),
  }),
  blockedOutcomeSchema,
  outcomeBaseSchema.extend({ kind: z.literal('failed') }),
])

const receiptSchema = z.object({
  id: z.string().min(1).max(256).transform(pullRequestId),
  number: z.number().int().positive().safe(),
  url: z.url().max(4096),
  state: z.enum(['open', 'merged', 'closed-unmerged']),
  baseBranch: z.string().min(1).max(256),
  headBranch: z.string().min(1).max(256),
  remoteHead: z.string().regex(/^[a-f0-9]{40}$/),
})

const publicationSchema = z.object({
  id: z.string().regex(/^publication:run_[a-f0-9]{32}$/),
  revision: z.number().int().positive(),
  providerId: z.string().transform(codeHostProviderId),
  bindingId: z.string().transform(codeHostBindingId),
  repositoryId: z.string().transform(codeHostRepositoryId),
  repository: z.string().min(1).max(512),
  baseBranch: z.string().min(1).max(256),
  headBranch: z.string().min(1).max(256),
  baseHead: z.string().regex(/^[a-f0-9]{40,64}$/),
  localHead: z.string().regex(/^[a-f0-9]{40,64}$/),
  marker: z.string().min(1).max(256),
  title: boundedNonEmptyString(MAX_OUTCOME_TEXT_BYTES, 'publication title'),
  body: boundedNonEmptyString(32 * 1024, 'publication body'),
  status: z.enum(['pending', 'in-flight', 'uncertain', 'retryable-failure', 'exhausted', 'failed', 'succeeded']),
  attempts: z.number().int().nonnegative(),
  owner: z.string().uuid().optional(),
  nextRetryAt: z.iso.datetime({ offset: true }).optional(),
  exhaustedFrom: z.enum(['uncertain', 'retryable-failure']).optional(),
  lastError: boundedNonEmptyString(MAX_OUTCOME_TEXT_BYTES, 'publication error').optional(),
  branchReceipt: z
    .object({
      remoteHead: z.string().regex(/^[a-f0-9]{40}$/),
      receivedAt: z.iso.datetime({ offset: true }),
    })
    .optional(),
  receipt: receiptSchema.optional(),
})

const deliveryBaseSchema = z.object({
  id: z.string().regex(/^delivery:[a-f0-9]{40}$/),
  eventId: z.string().regex(/^event:[a-f0-9]{40}$/),
  revision: z.number().int().positive(),
  status: z.enum([
    'pending',
    'in-flight',
    'uncertain',
    'retryable-failure',
    'exhausted',
    'permanent-failure',
    'succeeded',
    'retired',
  ]),
  attempts: z.number().int().nonnegative(),
  owner: z.string().uuid().optional(),
  nextRetryAt: z.iso.datetime({ offset: true }).optional(),
  exhaustedFrom: z.enum(['uncertain', 'retryable-failure']).optional(),
  lastError: boundedNonEmptyString(MAX_OUTCOME_TEXT_BYTES, 'delivery error').optional(),
  receiptId: z.string().min(1).max(512).optional(),
  receivedAt: z.iso.datetime({ offset: true }).optional(),
})

const trackerReportPayloadSchema = z.object({
  kind: z.literal('report'),
  deliveryId: z.string().min(1).max(512),
  eventId: z.string().min(1).max(512),
  bindingId: z.string().transform(trackerBindingId),
  issueId: z.string().transform(trackerIssueId),
  displayKey: z.string().min(1).max(256),
  body: boundedNonEmptyString(32 * 1024, 'tracker report'),
})
const trackerProjectionPayloadSchema = z.object({
  kind: z.literal('projection'),
  deliveryId: z.string().min(1).max(512),
  eventId: z.string().min(1).max(512),
  bindingId: z.string().transform(trackerBindingId),
  issueId: z.string().transform(trackerIssueId),
  displayKey: z.string().min(1).max(256),
  readinessGeneration: z.string().transform(readinessGeneration),
  runRevision: z.number().int().nonnegative(),
  desiredState: z.enum(['queued', 'implementing', 'paused', 'blocked', 'failed', 'completed']),
})

const notificationEventSchema = z.object({
  version: z.literal(1),
  eventId: z.string().min(1).max(512),
  runId: z.string().min(1).max(256),
  timestamp: z.iso.datetime({ offset: true }),
  type: z.enum(['started', 'blocked', 'paused', 'failed', 'completed']),
  issueIdentity: z.string().min(1).max(1024),
  displayKey: z.string().min(1).max(256),
  summary: boundedNonEmptyString(MAX_OUTCOME_TEXT_BYTES, 'notification summary'),
  actionNeeded: boundedNonEmptyString(MAX_OUTCOME_TEXT_BYTES, 'notification action').optional(),
  runUrl: z.url().max(4096),
  issueUrl: z.url().max(4096),
  pullRequestUrl: z.url().max(4096).optional(),
  usage: z.object({
    kind: z.enum(['provider', 'estimate', 'unknown']),
    tokens: z.number().int().nonnegative().optional(),
  }),
})

const deliverySchema = z.discriminatedUnion('kind', [
  deliveryBaseSchema.extend({
    kind: z.literal('tracker-report'),
    providerId: z.string().transform(trackerProviderId),
    payload: trackerReportPayloadSchema,
  }),
  deliveryBaseSchema.extend({
    kind: z.literal('tracker-projection'),
    providerId: z.string().transform(trackerProviderId),
    payload: trackerProjectionPayloadSchema,
  }),
  deliveryBaseSchema.extend({
    kind: z.literal('notification'),
    providerId: z.string().transform(notificationProviderId),
    destinationId: z.string().transform(notificationDestinationId),
    payload: notificationEventSchema,
  }),
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
  state: z.enum(['publishing', 'completed', 'blocked', 'failed']),
  execution: executionSchema,
  budget: runBudgetSchema,
  outcome: outcomeSchema,
  completedAt: z.iso.datetime({ offset: true }),
  publication: publicationSchema.optional(),
})
const cancellationBaseSchema = z.object({
  requestId: z.string().uuid(),
  cancelledAt: z.iso.datetime({ offset: true }),
})
const cancelledQueuedRunSchema = queuedRunSchema.omit({ state: true }).extend({
  state: z.literal('cancelled'),
  cancellation: cancellationBaseSchema.extend({ from: z.literal('queued') }),
})
const cancelledPausedQueuedRunSchema = pausedQueuedRunSchema.omit({ state: true }).extend({
  state: z.literal('cancelled'),
  cancellation: cancellationBaseSchema.extend({ from: z.literal('paused-queued') }),
})
const cancelledPausedActiveRunSchema = pausedActiveRunSchema.omit({ state: true }).extend({
  state: z.literal('cancelled'),
  cancellation: cancellationBaseSchema.extend({ from: z.literal('paused-active') }),
})
const cancelledBlockedRunSchema = terminalRunSchema.omit({ state: true, outcome: true }).extend({
  state: z.literal('cancelled'),
  outcome: blockedOutcomeSchema,
  cancellation: cancellationBaseSchema.extend({ from: z.literal('blocked') }),
})
const runSchema = z.union([
  queuedRunSchema,
  pausedQueuedRunSchema,
  implementingRunSchema,
  pausingRunSchema,
  pausedActiveRunSchema,
  terminalRunSchema,
  cancelledQueuedRunSchema,
  cancelledPausedQueuedRunSchema,
  cancelledPausedActiveRunSchema,
  cancelledBlockedRunSchema,
])
export const schedulerModeSchema = z.enum(['enabled', 'draining', 'disabled'])
const schedulerSchema = z.object({
  mode: schedulerModeSchema,
  changedAt: z.iso.datetime({ offset: true }),
})
const aggregateBudgetSchema = z.object({
  reservedTokens: z.number().int().nonnegative(),
  settledTokens: z.number().int().nonnegative(),
  usageUncertain: z.boolean(),
})

export const stateSchema = z
  .object({
    schemaVersion: z.literal(7),
    revision: z.number().int().nonnegative(),
    nextSequence: z.number().int().positive(),
    runs: z.array(runSchema),
    acceptedIngress: z.array(z.string().min(1).max(512).regex(ID_PATTERN)).max(MAX_INGRESS_RECEIPTS),
    operatorCommands: z.array(operatorCommandSchema).max(MAX_OPERATOR_COMMANDS).default([]),
    scheduler: schedulerSchema,
    budget: aggregateBudgetSchema,
  })
  .superRefine(validateStateIntegrity)
  .refine((value) => textEncoder.encode(JSON.stringify(value)).byteLength <= MAX_STATE_BYTES, {
    error: `admission state must not exceed ${String(MAX_STATE_BYTES)} UTF-8 bytes`,
  })

export type AdmissionState = z.infer<typeof stateSchema>

export const legacyAdmissionStateSchema = z
  .object({
    schemaVersion: z.literal(6),
    revision: z.number().int().nonnegative(),
    nextSequence: z.number().int().positive(),
    runs: z.array(z.unknown()),
    acceptedIngress: z.array(z.string().min(1).max(512).regex(ID_PATTERN)).max(MAX_INGRESS_RECEIPTS),
    scheduler: schedulerSchema,
    budget: aggregateBudgetSchema,
  })
  .refine((value) => textEncoder.encode(JSON.stringify(value)).byteLength <= MAX_STATE_BYTES, {
    error: `admission state must not exceed ${String(MAX_STATE_BYTES)} UTF-8 bytes`,
  })

export type LegacyAdmissionState = z.infer<typeof legacyAdmissionStateSchema>
export type StoredAdmissionState = AdmissionState | LegacyAdmissionState
export const storedAdmissionStateSchema = z.union([stateSchema, legacyAdmissionStateSchema])
