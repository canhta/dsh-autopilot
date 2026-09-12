import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { runIdSchema } from '../admission/state.js'
import type { RunId } from '../admission.js'
import type { MaintenanceAudit } from './model.js'

export const MAINTENANCE_STATE_KEY = 'primary' as const
const pathSchema = z.string().min(1).max(4096)

const mergeObservationSchema = z.object({
  runId: runIdSchema,
  firstObservedMergedAt: z.iso.datetime({ offset: true }),
  lastObservedMergedAt: z.iso.datetime({ offset: true }),
})

const pendingCleanupSchema = z.object({
  operationId: z.string().uuid(),
  runId: runIdSchema,
  worktreePath: pathSchema,
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  startedAt: z.iso.datetime({ offset: true }),
})

const auditSchema = z.object({
  id: z.string().uuid(),
  operationId: z.string().uuid().optional(),
  at: z.iso.datetime({ offset: true }),
  kind: z.enum(['merge-observed', 'cleanup-started', 'cleanup-removed', 'cleanup-rejected', 'cleanup-recovered']),
  runId: runIdSchema,
  worktreePath: pathSchema,
  outcome: z.enum(['completed', 'retry-required']).optional(),
  detail: z.string().min(1).max(4096),
})

export const maintenanceStateSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  mergeObservations: z.array(mergeObservationSchema).max(100),
  pendingCleanup: pendingCleanupSchema.optional(),
  audit: z.array(auditSchema).max(1000),
})

export type MaintenanceState = z.infer<typeof maintenanceStateSchema>

export const maintenanceDomainSpec = defineDomain({
  name: 'autopilot_maintenance',
  version: 1,
  tables: {
    state: domainTable<typeof MAINTENANCE_STATE_KEY, MaintenanceState>(maintenanceStateSchema),
  },
})

export function initialMaintenanceState(): MaintenanceState {
  return { schemaVersion: 1, revision: 0, mergeObservations: [], audit: [] }
}

export function existingMergeObservation(state: MaintenanceState, runId: RunId) {
  return state.mergeObservations.find((observation) => observation.runId === runId)
}

export function appendMaintenanceAudit(state: MaintenanceState, audit: MaintenanceAudit): MaintenanceState {
  return { ...state, audit: [...state.audit, audit].slice(-1000) }
}
