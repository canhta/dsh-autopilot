import { z } from 'zod'

export const runLifecycleSchema = z.enum([
  'queued',
  'implementing',
  'pausing',
  'paused',
  'publishing',
  'completed',
  'blocked',
  'failed',
  'cancelled',
])
export type RunLifecycle = z.infer<typeof runLifecycleSchema>

export const operationsQuerySchema = z.object({
  offset: z.number().int().min(0).max(10_000).default(0),
  limit: z.number().int().min(1).max(100).default(50),
  search: z.string().max(256).optional(),
  states: z.array(runLifecycleSchema).max(9).optional(),
  attentionOnly: z.boolean().optional(),
})
export type OperationsQuery = z.infer<typeof operationsQuerySchema>

export const providerViewSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  configurationNamespace: z.string(),
  selected: z.boolean(),
  availability: z.enum(['available', 'unavailable']),
  setup: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('available'),
      mcpServerName: z.string(),
      resources: z.array(z.object({ label: z.string(), value: z.string() })),
      credentialRefs: z.array(z.object({ label: z.string(), ref: z.string() })),
      lookup: z.discriminatedUnion('status', [
        z.object({ status: z.literal('available') }),
        z.object({ status: z.literal('unavailable'), reason: z.string() }),
      ]),
    }),
    z.object({ status: z.literal('unavailable'), reason: z.string() }),
  ]),
})
export type ProviderView = z.infer<typeof providerViewSchema>

export const providerSetupViewSchema = providerViewSchema.shape.setup
export type ProviderSetupView = z.infer<typeof providerSetupViewSchema>

export const usageViewSchema = z.union([
  z.object({ kind: z.literal('known'), settled: z.number().int().min(0), reserved: z.number().int().min(0) }),
  z.object({ kind: z.literal('unknown'), reason: z.string() }),
])
export type UsageView = z.infer<typeof usageViewSchema>

export const externalReferenceSchema = z.union([
  z.object({ status: z.literal('available'), url: z.string().url(), label: z.string() }),
  z.object({ status: z.literal('unknown'), reason: z.string() }),
])
export type ExternalReferenceView = z.infer<typeof externalReferenceSchema>

const knownBooleanSchema = z.union([
  z.object({ status: z.literal('known'), value: z.boolean() }),
  z.object({ status: z.literal('unknown'), reason: z.string() }),
])

export const worktreeViewSchema = z.object({
  path: z.string(),
  branch: z.string(),
  head: z.string().optional(),
  state: z.enum(['active', 'retained', 'cleanup-eligible', 'missing', 'unsafe', 'unknown']),
  dirty: knownBooleanSchema,
  untracked: knownBooleanSchema,
  unpushed: knownBooleanSchema,
  pullRequestDisposition: z.enum(['open', 'merged', 'closed-unmerged', 'unknown']),
  cleanup: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('available'),
      eligible: z.boolean(),
      rejections: z.array(
        z.enum([
          'run-active',
          'run-paused',
          'run-publishing',
          'run-blocked',
          'run-failed',
          'external-intent-unresolved',
          'recovery-required',
          'ownership-unproven',
          'worktree-missing',
          'dirty-files',
          'untracked-files',
          'unpushed-commits',
          'pr-open',
          'pr-unknown',
          'pr-closed-unmerged',
          'retention-not-met',
        ]),
      ),
      removableBytes: z.union([z.number().int().nonnegative(), z.literal('unknown')]),
      retentionReference: z.string().datetime().optional(),
      retentionEligibleAt: z.string().datetime().optional(),
    }),
    z.object({ status: z.literal('unavailable'), reason: z.string() }),
  ]),
})
export type WorktreeView = z.infer<typeof worktreeViewSchema>

export const cleanupPreviewViewSchema = worktreeViewSchema.extend({ previewId: z.string().uuid() })
export type CleanupPreviewView = z.infer<typeof cleanupPreviewViewSchema>

export const deliveryViewSchema = z.object({
  id: z.string(),
  kind: z.enum(['tracker-report', 'tracker-projection', 'notification']),
  providerId: z.string(),
  destination: z.string(),
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
  nextRetryAt: z.string().datetime().optional(),
  receivedAt: z.string().datetime().optional(),
  lastError: z.string().optional(),
  retryable: z.boolean(),
})
export type DeliveryView = z.infer<typeof deliveryViewSchema>

export const timelineEntrySchema = z.object({
  at: z.string().datetime(),
  label: z.string(),
  detail: z.string().optional(),
})
export type TimelineEntryView = z.infer<typeof timelineEntrySchema>

export const runSummarySchema = z.object({
  runId: z.string(),
  displayKey: z.string(),
  summary: z.string(),
  providerId: z.string(),
  providerName: z.string(),
  lifecycle: runLifecycleSchema,
  reason: z.string(),
  priorityRank: z.number().int().min(0),
  phase: z.string(),
  queuedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  attention: z.boolean(),
  usage: usageViewSchema,
  ticket: externalReferenceSchema,
  session: externalReferenceSchema,
  pullRequest: externalReferenceSchema,
  deliveries: z.array(deliveryViewSchema).max(64),
  actions: z.array(z.enum(['pause-run', 'resume-run', 'cancel-run'])),
  worktree: worktreeViewSchema.optional(),
})
export type RunSummaryView = z.infer<typeof runSummarySchema>

export const runDetailSchema = runSummarySchema.extend({
  brief: z.object({ updatedAt: z.string().datetime(), content: z.string() }),
  outcome: z
    .object({ kind: z.enum(['verified', 'blocked', 'failed']), summary: z.string(), evidence: z.array(z.string()) })
    .optional(),
  timeline: z.array(timelineEntrySchema),
})
export type RunDetailView = z.infer<typeof runDetailSchema>

export const commandKindSchema = z.enum([
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
export type CommandKind = z.infer<typeof commandKindSchema>

export const commandRequestSchema = z.object({
  requestId: z.string().uuid(),
  kind: commandKindSchema,
  runId: z.string().optional(),
  deliveryId: z.string().optional(),
  previewId: z.string().uuid().optional(),
})
export type CommandRequest = z.infer<typeof commandRequestSchema>

export const commandReceiptSchema = z.object({
  requestId: z.string().uuid(),
  kind: commandKindSchema,
  status: z.enum(['accepted', 'in-progress', 'succeeded', 'rejected']),
  acceptedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  message: z.string().optional(),
  revision: z.number().int().min(0).optional(),
})
export type CommandReceipt = z.infer<typeof commandReceiptSchema>

export const reconciliationViewSchema = z.object({
  active: z.number().int().min(0),
  nextScheduledAt: z.string().datetime().optional(),
  lastAttempt: z
    .object({
      source: z.enum(['manual', 'scheduled', 'startup', 'webhook']),
      completedAt: z.string().datetime(),
      outcome: z.enum(['succeeded', 'failed']),
      admitted: z.number().int().min(0),
      failure: z.string().optional(),
    })
    .optional(),
})
export type ReconciliationView = z.infer<typeof reconciliationViewSchema>

export const operationsSnapshotSchema = z.object({
  revision: z.number().int().min(0),
  fetchedAt: z.string().datetime(),
  scheduler: z.object({
    mode: z.enum(['enabled', 'draining', 'disabled']),
    changedAt: z.string().datetime(),
  }),
  providers: z.array(providerViewSchema),
  runs: z.object({
    items: z.array(runSummarySchema),
    total: z.number().int().min(0),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1),
  }),
  budget: z.object({
    deploymentCap: z.number().int().min(0),
    settled: z.number().int().min(0),
    reserved: z.number().int().min(0),
    remaining: z.number().int().min(0).nullable(),
    usageUncertain: z.boolean(),
  }),
  schedule: z.object({
    timezone: z.string(),
    reconcileIntervalSeconds: z.number().int().min(1),
  }),
  reconciliation: reconciliationViewSchema,
  commands: z.array(commandReceiptSchema).max(64),
  integrations: z.object({
    deliveries: z.discriminatedUnion('status', [
      z.object({ status: z.literal('available') }),
      z.object({ status: z.literal('unavailable'), reason: z.string() }),
    ]),
    worktrees: z.discriminatedUnion('status', [
      z.object({ status: z.literal('available') }),
      z.object({ status: z.literal('unavailable'), reason: z.string() }),
    ]),
  }),
})
export type OperationsSnapshot = z.infer<typeof operationsSnapshotSchema>

export const providerTestResultSchema = z.object({
  providerId: z.string(),
  checkedAt: z.string().datetime(),
  status: z.enum(['ready', 'failed']),
  reason: z.string().optional(),
})
export type ProviderTestResult = z.infer<typeof providerTestResultSchema>
