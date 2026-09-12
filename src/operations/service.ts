import { randomUUID } from 'node:crypto'
import { type Context, Service } from '@deepseek-ai/cordis'
import type { RunId } from '../admission.js'
import { CleanupOperations } from './cleanup.js'
import { CleanupInspector } from './cleanup-inspector.js'
import { projectOperationsHealth } from './health.js'
import { pathExists } from './inspection.js'
import type {
  CleanupPreview,
  MaintenanceAudit,
  OperationsHealth,
  OrphanWorktreeFact,
  RecoveryParticipant,
  RetainedWorktreeFact,
} from './model.js'
import { RecoveryParticipants } from './recovery.js'
import { RetentionMaintenance } from './retention.js'
import { appendMaintenanceAudit } from './state.js'
import { MaintenanceStateStore } from './store.js'

export interface AutopilotOperationsOptions {
  readonly now?: () => number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    autopilotOperations: AutopilotOperations
  }
}

/** Coordinate conservative retained-worktree maintenance, recovery readiness, audit, and operational health. */
export class AutopilotOperations extends Service {
  static readonly inject = [
    'admission',
    'autopilotConfig',
    'pullRequestDisposition',
    'runtimeOwner',
    'storageDomain',
    'subprocess',
  ]

  private readonly store: MaintenanceStateStore
  private readonly recovery = new RecoveryParticipants()
  private readonly inspector: CleanupInspector
  private readonly cleanup: CleanupOperations
  private readonly retention: RetentionMaintenance
  private readonly now: () => number
  private readying: Promise<void> | undefined
  private storeRecovered = false

  constructor(ctx: Context, options: AutopilotOperationsOptions = {}) {
    super(ctx, 'autopilotOperations')
    this.now = options.now ?? Date.now
    this.store = new MaintenanceStateStore(ctx)
    this.inspector = new CleanupInspector(ctx, this.store, this.now)
    this.cleanup = new CleanupOperations(ctx, this.store, this.inspector, () => this.ensureStore(), this.now)
    this.retention = new RetentionMaintenance(ctx, this.store, this.cleanup, () => this.ensureStore())
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    const releaseOwnerHold = this.ctx.runtimeOwner.hold()
    let stopSettingsWatch: (() => void) | undefined
    try {
      await this.ensureStore()
      stopSettingsWatch = this.ctx.autopilotConfig.watch(() => this.retention.reschedule())
    } catch (error) {
      try {
        await this.store.close()
      } catch {
        // Preserve the recovery failure that prevented the service from mounting.
      } finally {
        releaseOwnerHold()
      }
      throw error
    }
    yield async () => {
      stopSettingsWatch?.()
      try {
        await this.retention.stop()
        await this.recovery.dispose()
        await this.store.close()
      } finally {
        releaseOwnerHold()
      }
    }
    this.retention.schedule(0)
  }

  /** Register one effect-owned recovery generation; disposal withdraws, cancels, and drains active reconciliation. */
  registerRecoveryParticipant(id: string, participant: RecoveryParticipant): () => Promise<void> {
    return this.recovery.register(id, participant)
  }

  /** Reconcile every required contributor and reject execution while durable restart work remains unresolved. */
  async assertDispatchReady(): Promise<void> {
    await this.ensureStore()
    await this.recovery.reconcileAll()
    if (this.health().recovery.status !== 'complete') {
      throw new Error('Autopilot recovery must be completed before execution starts')
    }
  }

  /** Inspect one allocated run and retain an opaque process-local authorization preview. */
  previewCleanup(runId: RunId): Promise<CleanupPreview> {
    return this.cleanup.preview(runId)
  }

  /** Inspect one allocated run without retaining an authorization capable cleanup preview. */
  inspectCleanup(runId: RunId): Promise<Omit<CleanupPreview, 'previewId'>> {
    return this.cleanup.inspect(runId)
  }

  /** Recheck and consume one eligible preview, persist intent, and remove only through native Git worktree operations. */
  removeWorktree(previewId: string, operationId?: string): Promise<CleanupPreview> {
    return this.cleanup.remove(previewId, operationId)
  }

  /** Reconcile a replayed Web cleanup command against its durable maintenance outcome. */
  async cleanupCommandOutcome(operationId: string): Promise<'completed' | 'pending' | 'retry-required' | 'unknown'> {
    await this.ensureStore()
    const state = this.store.current()
    if (state.pendingCleanup?.operationId === operationId) return 'pending'
    return state.audit.findLast((entry) => entry.operationId === operationId)?.outcome ?? 'unknown'
  }

  /** Run the automatic retention policy through the same preview, recheck, intent, and removal path. */
  runRetentionMaintenance(): Promise<{ inspected: number; removed: number; attention: number }> {
    return this.retention.run()
  }

  /** Project retained, missing, unsafe, and orphaned worktrees without authorizing orphan deletion. */
  inspectWorktrees(): Promise<{
    retained: readonly RetainedWorktreeFact[]
    orphans: readonly OrphanWorktreeFact[]
    audit: readonly MaintenanceAudit[]
  }> {
    return this.retention.inspectWorktrees()
  }

  /** Return independent process, persistence, recovery, integration, and admission health facts without I/O. */
  health(): OperationsHealth {
    return projectOperationsHealth(this.ctx, this.store, this.recovery, this.inspector)
  }

  private async ensureStore(): Promise<void> {
    if (this.storeRecovered) return
    if (this.readying !== undefined) return await this.readying
    this.readying = this.openStore()
    try {
      await this.readying
    } finally {
      this.readying = undefined
    }
  }

  private async openStore(): Promise<void> {
    await this.store.open()
    await this.reconcilePendingCleanup()
    this.storeRecovered = true
  }

  private async reconcilePendingCleanup(): Promise<void> {
    const pending = this.store.current().pendingCleanup
    if (pending === undefined) return
    const remains = await pathExists(pending.worktreePath)
    await this.store.update((state) => ({
      ...appendMaintenanceAudit(state, {
        id: randomUUID(),
        operationId: pending.operationId,
        at: new Date(this.now()).toISOString(),
        kind: 'cleanup-recovered',
        runId: pending.runId,
        worktreePath: pending.worktreePath,
        outcome: remains ? 'retry-required' : 'completed',
        detail: remains
          ? 'interrupted cleanup left the path present; a new preview is required'
          : 'interrupted cleanup completed before acknowledgement; the absent path was retained as the outcome',
      }),
      pendingCleanup: undefined,
    }))
  }
}

export default AutopilotOperations
