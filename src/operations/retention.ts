import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CleanupOperations } from './cleanup.js'
import {
  boundedError,
  canonicalExistingPath,
  hasExecution,
  inside,
  inspectOwnership,
  listWorktrees,
  pathExists,
} from './inspection.js'
import type { MaintenanceAudit, OrphanWorktreeFact, RetainedWorktreeFact } from './model.js'
import type { MaintenanceStateStore } from './store.js'

export class RetentionMaintenance {
  private timer: ReturnType<typeof setTimeout> | undefined
  private attempt: Promise<void> | undefined
  private stopping = false

  constructor(
    private readonly ctx: Context,
    private readonly store: MaintenanceStateStore,
    private readonly cleanup: CleanupOperations,
    private readonly ensureReady: () => Promise<void>,
  ) {}

  async run(): Promise<{ inspected: number; removed: number; attention: number }> {
    await this.ensureReady()
    const runs = this.ctx.admission.snapshot().runs.filter(hasExecution)
    let removed = 0
    let attention = 0
    for (const run of runs) {
      const preview = await this.cleanup.preview(run.runId)
      if (!preview.eligible) {
        this.cleanup.discardPreview(preview.previewId)
        attention += 1
        continue
      }
      await this.cleanup.remove(preview.previewId)
      removed += 1
    }
    return { inspected: runs.length, removed, attention }
  }

  async inspectWorktrees(): Promise<{
    retained: readonly RetainedWorktreeFact[]
    orphans: readonly OrphanWorktreeFact[]
    audit: readonly MaintenanceAudit[]
  }> {
    await this.ensureReady()
    const settings = this.ctx.autopilotConfig.get()
    const allocated = this.ctx.admission.snapshot().runs.filter(hasExecution)
    const retained = await Promise.all(
      allocated.map(async (run): Promise<RetainedWorktreeFact> => {
        try {
          await inspectOwnership(this.ctx, run, settings.managedWorktreeRoot)
          return { runId: run.runId, path: run.execution.worktreePath, state: 'managed' }
        } catch (error) {
          return {
            runId: run.runId,
            path: run.execution.worktreePath,
            state: (await pathExists(run.execution.worktreePath)) ? 'unsafe' : 'missing',
            detail: boundedError(error),
          }
        }
      }),
    )
    const registered = await listWorktrees(this.ctx, settings.targetRepository)
    const managedRoot = await canonicalExistingPath(settings.managedWorktreeRoot)
    const ownedPaths = new Set(
      await Promise.all(
        allocated.map(async (run) => {
          try {
            return await canonicalExistingPath(run.execution.worktreePath)
          } catch {
            return resolve(run.execution.worktreePath)
          }
        }),
      ),
    )
    const orphans = registered
      .filter((worktree) => inside(managedRoot, resolve(worktree.path)) && !ownedPaths.has(resolve(worktree.path)))
      .map(
        (worktree): OrphanWorktreeFact => ({
          path: resolve(worktree.path),
          ...(worktree.branch === undefined ? {} : { branch: worktree.branch }),
          state: 'orphan-reconciliation-required',
        }),
      )
    return { retained, orphans, audit: structuredClone(this.store.current().audit) }
  }

  schedule(delay?: number): void {
    const settings = this.ctx.autopilotConfig.get()
    if (this.stopping || this.timer !== undefined || !settings.autoCleanupEnabled) {
      return
    }
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        const attempt = this.run()
          .then(() => undefined)
          .catch(() => this.ctx.logger.warn('autopilot retention maintenance failed'))
          .finally(() => {
            if (this.attempt === attempt) this.attempt = undefined
            this.schedule()
          })
        this.attempt = attempt
      },
      delay ?? settings.reconcileIntervalSeconds * 1000,
    )
  }

  reschedule(): void {
    this.clearTimer()
    if (this.attempt === undefined) this.schedule()
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.clearTimer()
    await Promise.all([this.attempt, this.cleanup.activeAttempt()])
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}
