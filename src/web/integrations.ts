import { type Context, Service } from '@deepseek-ai/cordis'
import type { DeliveryRecord, RunId } from '../admission.js'
import type { CleanupPreview as OperationsCleanupPreview } from '../operations.js'
import type { DeliveryView, WorktreeView } from './contract.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    autopilotWebIntegrations: AutopilotWebIntegrations
  }
}

/** Browser-safe adapters over the authoritative publication, delivery, and maintenance owners. */
export class AutopilotWebIntegrations extends Service {
  static readonly inject = ['admission', 'delivery', 'autopilotOperations', 'autopilotWebContributions']

  constructor(ctx: Context) {
    super(ctx, 'autopilotWebIntegrations')
  }

  async *[Service.init](): AsyncGenerator<() => void, void, void> {
    const disposeDeliveries = this.ctx.autopilotWebContributions.registerDelivery({
      id: 'publication-delivery',
      views: (runId) => {
        const run = this.ctx.admission.snapshot().runs.find((candidate) => candidate.runId === runId)
        return run === undefined ? undefined : run.deliveries.map(deliveryView)
      },
    })
    const disposeWorktrees = this.ctx.autopilotWebContributions.registerWorktree({
      id: 'retained-worktrees',
      inspect: async (runId, signal) => {
        signal?.throwIfAborted()
        if (!hasWorktree(this.ctx, runId)) return undefined
        const inspection = await this.ctx.autopilotOperations.inspectCleanup(runId)
        signal?.throwIfAborted()
        return worktreeView(inspection)
      },
      preview: async (runId, signal) => {
        signal?.throwIfAborted()
        if (!hasWorktree(this.ctx, runId)) return undefined
        const preview = await this.ctx.autopilotOperations.previewCleanup(runId)
        signal?.throwIfAborted()
        return { previewId: preview.previewId, ...worktreeView(preview) }
      },
    })
    yield () => {
      disposeWorktrees()
      disposeDeliveries()
    }
  }
}

function deliveryView(delivery: DeliveryRecord): DeliveryView {
  return {
    id: delivery.id,
    kind: delivery.kind,
    providerId: delivery.providerId,
    destination:
      delivery.kind === 'notification'
        ? `${delivery.providerId}:${delivery.destinationId}`
        : delivery.payload.displayKey,
    status: delivery.status,
    attempts: delivery.attempts,
    ...(delivery.nextRetryAt === undefined ? {} : { nextRetryAt: delivery.nextRetryAt }),
    ...(delivery.receivedAt === undefined ? {} : { receivedAt: delivery.receivedAt }),
    ...(delivery.lastError === undefined ? {} : { lastError: delivery.lastError }),
    retryable: !['succeeded', 'retired', 'in-flight'].includes(delivery.status),
  }
}

function worktreeView(preview: Omit<OperationsCleanupPreview, 'previewId'> | OperationsCleanupPreview): WorktreeView {
  const missing = preview.rejections.includes('worktree-missing')
  const unsafe = preview.rejections.includes('ownership-unproven')
  const active = preview.rejections.includes('run-active')
  return {
    path: preview.worktreePath,
    branch: preview.branch,
    ...(preview.head === undefined ? {} : { head: preview.head }),
    state: missing
      ? 'missing'
      : unsafe
        ? 'unsafe'
        : active
          ? 'active'
          : preview.eligible
            ? 'cleanup-eligible'
            : 'retained',
    dirty: { status: 'known', value: preview.dirtyFiles.length > 0 },
    untracked: { status: 'known', value: preview.untrackedFiles.length > 0 },
    unpushed:
      preview.unpushedCommits === 'unknown'
        ? { status: 'unknown', reason: 'The remote head could not be compared safely.' }
        : { status: 'known', value: preview.unpushedCommits > 0 },
    pullRequestDisposition: preview.disposition.state,
    cleanup: {
      status: 'available',
      eligible: preview.eligible,
      rejections: [...preview.rejections],
      removableBytes: preview.removableBytes,
      ...(preview.retentionReference === undefined ? {} : { retentionReference: preview.retentionReference }),
      ...(preview.retentionEligibleAt === undefined ? {} : { retentionEligibleAt: preview.retentionEligibleAt }),
    },
  }
}

function hasWorktree(ctx: Context, runId: RunId): boolean {
  const run = ctx.admission.snapshot().runs.find((candidate) => candidate.runId === runId)
  return run !== undefined && 'execution' in run
}

export default AutopilotWebIntegrations
