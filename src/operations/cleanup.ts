import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { RunId } from '../admission.js'
import { gitCommand } from '../dispatch/git.js'
import type { CleanupInspector } from './cleanup-inspector.js'
import { allocatedRun, boundedError } from './inspection.js'
import type { CleanupPreview } from './model.js'
import { appendMaintenanceAudit } from './state.js'
import type { MaintenanceStateStore } from './store.js'

const MAX_PREVIEWS = 100

export class CleanupOperations {
  private readonly previews = new Map<string, { preview: CleanupPreview; fingerprint: string; runGeneration: number }>()
  private attempt: Promise<CleanupPreview> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly store: MaintenanceStateStore,
    private readonly inspector: CleanupInspector,
    private readonly ensureReady: () => Promise<void>,
    private readonly now: () => number,
  ) {}

  activeAttempt(): Promise<CleanupPreview> | undefined {
    return this.attempt
  }

  discardPreview(previewId: string): void {
    this.previews.delete(previewId)
  }

  /** Inspect current cleanup facts without creating an authorization preview. */
  async inspect(runId: RunId): Promise<Omit<CleanupPreview, 'previewId'>> {
    await this.ensureReady()
    return await this.ctx.admission.runOperations.exclusive(runId, async () => {
      const inspected = await this.inspector.inspect(runId)
      return structuredClone(inspected.preview)
    })
  }

  async preview(runId: RunId): Promise<CleanupPreview> {
    await this.ensureReady()
    return await this.ctx.admission.runOperations.exclusive(runId, async () => {
      const inspected = await this.inspector.inspect(runId)
      const previewId = randomUUID()
      const preview: CleanupPreview = { previewId, ...inspected.preview }
      this.previews.set(previewId, {
        preview,
        fingerprint: inspected.fingerprint,
        runGeneration: this.ctx.admission.runOperations.generation(runId),
      })
      while (this.previews.size > MAX_PREVIEWS) this.previews.delete(this.previews.keys().next().value as string)
      return structuredClone(preview)
    })
  }

  async remove(previewId: string, operationId: string = randomUUID()): Promise<CleanupPreview> {
    if (this.attempt !== undefined) throw new Error('another cleanup operation is already in progress')
    const attempt = this.performRemoval(previewId, operationId)
    this.attempt = attempt
    try {
      return await attempt
    } finally {
      if (this.attempt === attempt) this.attempt = undefined
    }
  }

  private async performRemoval(previewId: string, operationId: string): Promise<CleanupPreview> {
    await this.ensureReady()
    const retained = this.previews.get(previewId)
    this.previews.delete(previewId)
    if (retained === undefined) {
      throw new Error('cleanup preview is missing, expired, or belongs to another Host process')
    }
    if (!retained.preview.eligible) {
      await this.auditRejection(retained.preview, 'cleanup preview was not eligible')
      throw new Error(`cleanup rejected: ${retained.preview.rejections.join(', ')}`)
    }
    return await this.ctx.admission.runOperations.exclusive(retained.preview.runId, async () => {
      if (this.ctx.admission.runOperations.generation(retained.preview.runId) !== retained.runGeneration) {
        await this.auditRejection(retained.preview, 'run lifecycle changed after cleanup preview')
        throw new Error('cleanup preview is stale; run lifecycle changed')
      }
      const current = await this.inspector.inspect(retained.preview.runId)
      if (current.fingerprint !== retained.fingerprint) {
        await this.auditRejection(retained.preview, 'cleanup preview changed during the mandatory recheck')
        throw new Error('cleanup preview is stale; run, Git, PR, or retention facts changed')
      }
      if (!current.preview.eligible) throw new Error(`cleanup rejected: ${current.preview.rejections.join(', ')}`)

      const startedAt = this.nowIso()
      await this.store.update((state) => ({
        ...appendMaintenanceAudit(state, {
          id: randomUUID(),
          operationId,
          at: startedAt,
          kind: 'cleanup-started',
          runId: current.preview.runId,
          worktreePath: current.preview.worktreePath,
          detail: `cleanup intent ${operationId} persisted after authoritative recheck`,
        }),
        pendingCleanup: {
          operationId,
          runId: current.preview.runId,
          worktreePath: current.preview.worktreePath,
          previewFingerprint: current.fingerprint,
          startedAt,
        },
      }))

      const run = allocatedRun(this.ctx.admission.snapshot(), current.preview.runId)
      try {
        await gitCommand(this.ctx.subprocess, run.execution.targetRepository, [
          'worktree',
          'remove',
          current.preview.worktreePath,
        ])
      } catch (error) {
        await this.finish(
          current.preview,
          operationId,
          'cleanup-rejected',
          'retry-required',
          `Git refused cleanup: ${boundedError(error)}`,
        )
        throw error
      }
      await this.finish(
        current.preview,
        operationId,
        'cleanup-removed',
        'completed',
        'managed worktree removed; branch and retained data preserved',
      )
      return structuredClone({ ...retained.preview, removableBytes: 0 })
    })
  }

  private async finish(
    preview: Omit<CleanupPreview, 'previewId'>,
    operationId: string,
    kind: 'cleanup-rejected' | 'cleanup-removed',
    outcome: 'completed' | 'retry-required',
    detail: string,
  ): Promise<void> {
    await this.store.update((state) => ({
      ...appendMaintenanceAudit(state, {
        id: randomUUID(),
        operationId,
        at: this.nowIso(),
        kind,
        runId: preview.runId,
        worktreePath: preview.worktreePath,
        outcome,
        detail,
      }),
      pendingCleanup: undefined,
    }))
  }

  private async auditRejection(preview: CleanupPreview, detail: string): Promise<void> {
    await this.store.update((state) =>
      appendMaintenanceAudit(state, {
        id: randomUUID(),
        at: this.nowIso(),
        kind: 'cleanup-rejected',
        runId: preview.runId,
        worktreePath: preview.worktreePath,
        detail,
      }),
    )
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString()
  }
}
