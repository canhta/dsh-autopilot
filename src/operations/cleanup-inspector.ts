import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { RunId } from '../admission.js'
import { gitCommand } from '../dispatch/git.js'
import type { PullRequestDisposition } from './disposition.js'
import {
  type AllocatedRun,
  allocatedRun,
  cleanupRejections,
  directoryBytes,
  fingerprint,
  inspectOwnership,
  parseStatus,
  pathExists,
} from './inspection.js'
import type { CleanupPreview } from './model.js'
import { appendMaintenanceAudit, existingMergeObservation } from './state.js'
import type { MaintenanceStateStore } from './store.js'

export class CleanupInspector {
  codeHostFailure: string | undefined

  constructor(
    private readonly ctx: Context,
    private readonly store: MaintenanceStateStore,
    private readonly now: () => number,
  ) {}

  async inspect(runId: RunId): Promise<{
    preview: Omit<CleanupPreview, 'previewId'>
    fingerprint: string
  }> {
    const admission = this.ctx.admission.snapshot()
    const run = allocatedRun(admission, runId)
    const settings = this.ctx.autopilotConfig.get()
    const disposition = await this.ctx.pullRequestDisposition.inspect(run.execution.codeHost.providerId, run)
    this.codeHostFailure = disposition.state === 'unknown' ? disposition.reason : undefined
    let firstObservedMergedAt: string | undefined
    if (disposition.state === 'merged') firstObservedMergedAt = await this.observeMerged(run, disposition)

    let ownership = false
    let missing = false
    let head: string | undefined
    let dirtyFiles: string[] = []
    let untrackedFiles: string[] = []
    let removableBytes: number | 'unknown' = 'unknown'
    try {
      await inspectOwnership(this.ctx, run, settings.managedWorktreeRoot)
      ownership = true
      head = (await gitCommand(this.ctx.subprocess, run.execution.worktreePath, ['rev-parse', 'HEAD'])).trim()
      const status = await gitCommand(this.ctx.subprocess, run.execution.worktreePath, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
      ])
      ;({ dirtyFiles, untrackedFiles } = parseStatus(status))
      removableBytes = await directoryBytes(run.execution.worktreePath)
    } catch {
      missing = !(await pathExists(run.execution.worktreePath))
    }

    let unpushedCommits: number | 'unknown' = 'unknown'
    if (ownership && head !== undefined && 'head' in disposition && disposition.head !== undefined) {
      try {
        unpushedCommits = Number.parseInt(
          (
            await gitCommand(this.ctx.subprocess, run.execution.worktreePath, [
              'rev-list',
              '--count',
              `${disposition.head}..${head}`,
            ])
          ).trim(),
          10,
        )
        if (!Number.isSafeInteger(unpushedCommits) || unpushedCommits < 0) unpushedCommits = 'unknown'
      } catch {
        unpushedCommits = 'unknown'
      }
    }

    const retentionReference =
      disposition.state === 'merged' ? (disposition.mergedAt ?? firstObservedMergedAt) : undefined
    const retentionEligibleAt =
      retentionReference === undefined
        ? undefined
        : new Date(Date.parse(retentionReference) + settings.cleanupRetentionDays * 86_400_000).toISOString()
    const rejections = cleanupRejections({
      run,
      disposition,
      ownership,
      missing,
      dirtyFiles,
      untrackedFiles,
      unpushedCommits,
      ...(retentionEligibleAt === undefined ? {} : { retentionEligibleAt }),
      now: this.now(),
    })
    const preview = {
      runId,
      admissionRevision: admission.revision,
      worktreePath: run.execution.worktreePath,
      branch: run.execution.branch,
      ...(head === undefined ? {} : { head }),
      dirtyFiles,
      untrackedFiles,
      unpushedCommits,
      disposition,
      ...(retentionReference === undefined ? {} : { retentionReference }),
      ...(retentionEligibleAt === undefined ? {} : { retentionEligibleAt }),
      removableBytes,
      retainedData: ['run', 'session', 'audit'] as const,
      eligible: rejections.length === 0,
      rejections,
    }
    return {
      preview,
      fingerprint: fingerprint({
        runId: preview.runId,
        worktreePath: preview.worktreePath,
        branch: preview.branch,
        head: preview.head,
        dirtyFiles: preview.dirtyFiles,
        untrackedFiles: preview.untrackedFiles,
        unpushedCommits: preview.unpushedCommits,
        disposition: preview.disposition,
        eligible: preview.eligible,
        rejections: preview.rejections,
      }),
    }
  }

  private async observeMerged(
    run: AllocatedRun,
    disposition: Extract<PullRequestDisposition, { state: 'merged' }>,
  ): Promise<string> {
    const now = new Date(this.now()).toISOString()
    let first = now
    await this.store.update((state) => {
      const existing = state.mergeObservations.find((observation) => observation.runId === run.runId)
      if (existing !== undefined) first = existing.firstObservedMergedAt
      const observations = state.mergeObservations.filter((observation) => observation.runId !== run.runId)
      observations.push({ runId: run.runId, firstObservedMergedAt: first, lastObservedMergedAt: now })
      return appendMaintenanceAudit(
        { ...state, mergeObservations: observations },
        {
          id: randomUUID(),
          at: now,
          kind: 'merge-observed',
          runId: run.runId,
          worktreePath: run.execution.worktreePath,
          detail:
            disposition.mergedAt === undefined
              ? 'merged PR observed without provider merge time'
              : 'provider merge time observed',
        },
      )
    }, existingMergeObservation(this.store.current(), run.runId) === undefined)
    return first
  }
}
