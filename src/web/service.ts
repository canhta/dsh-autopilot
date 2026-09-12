import { type Context, Service } from '@deepseek-ai/cordis'
import { bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol'
import { publicTrackerFailureMessage, TrackerProviderError, trackerProviderId } from '../tracker.js'
import { AutopilotCommands } from './commands.js'
import {
  type CleanupPreviewView,
  type CommandReceipt,
  type CommandRequest,
  type OperationsQuery,
  type OperationsSnapshot,
  operationsQuerySchema,
  type ProviderTestResult,
  type RunDetailView,
  type WorktreeView,
} from './contract.js'
import { detailOf, integrationViews, matchesQuery, providerNames, providerViews, summaryOf } from './projection.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    autopilotWeb: AutopilotWeb
  }
}

/** Typed Host boundary for the Autopilot Web contribution. */
export class AutopilotWeb extends Service {
  static readonly inject = [
    'admission',
    'autopilotConfig',
    'tracker',
    'autopilotReconciliation',
    'autopilotWebContributions',
  ]
  readonly typertRemote = bindTypertRemote(this, 'autopilotWeb', { namespace: 'autopilot' })
  private readonly commands: AutopilotCommands

  constructor(ctx: Context) {
    super(ctx, 'autopilotWeb')
    this.commands = new AutopilotCommands(ctx)
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    this.commands.start()
    yield () => this.commands.dispose()
  }

  /** Return one bounded, detached operations page without ticket bodies, secrets, or Session transcripts. */
  operations(query: OperationsQuery, signal?: AbortSignal): OperationsSnapshot {
    signal?.throwIfAborted()
    return this.snapshot(operationsQuerySchema.parse(query))
  }

  /** Return bounded detail for one run; optional integrations contribute only browser-safe projections. */
  run(runId: string, signal?: AbortSignal): RunDetailView | null {
    signal?.throwIfAborted()
    const run = this.ctx.admission.snapshot().runs.find((candidate) => candidate.runId === runId)
    return run === undefined
      ? null
      : detailOf(
          run,
          providerNames(this.ctx.tracker.providerRegistrations()),
          this.ctx.get('dispatch') !== undefined,
          this.ctx.autopilotWebContributions,
        )
  }

  /** Perform a current, non-authorizing Git/PR inspection for one retained worktree. */
  async worktree(runId: string, signal?: AbortSignal): Promise<WorktreeView | null> {
    signal?.throwIfAborted()
    const run = this.ctx.admission.snapshot().runs.find((candidate) => candidate.runId === runId)
    if (run === undefined || !('execution' in run)) return null
    return (await this.ctx.autopilotWebContributions.inspectWorktree(run.runId, signal)) ?? null
  }

  /** Create an opaque cleanup preview only after an explicit operator request. */
  async previewCleanup(runId: string, signal?: AbortSignal): Promise<CleanupPreviewView | null> {
    signal?.throwIfAborted()
    const run = this.ctx.admission.snapshot().runs.find((candidate) => candidate.runId === runId)
    if (run === undefined || !('execution' in run)) return null
    return (await this.ctx.autopilotWebContributions.previewCleanup(run.runId, signal)) ?? null
  }

  /** Accept an idempotent operator command and keep its Host-owned work alive independently of the browser. */
  async command(input: CommandRequest, signal?: AbortSignal): Promise<CommandReceipt> {
    signal?.throwIfAborted()
    return this.commands.command(input)
  }
  /** Read one accepted command after reconnect without replaying it. */
  commandStatus(requestId: string, signal?: AbortSignal): CommandReceipt | null {
    signal?.throwIfAborted()
    return this.commands.status(requestId)
  }

  /** Validate one available provider through its bounded candidate reader without returning ticket content. */
  async testProvider(providerId: string, signal: AbortSignal): Promise<ProviderTestResult> {
    const checkedAt = new Date().toISOString()
    try {
      await this.ctx.tracker.withProvider(trackerProviderId(providerId), async (reader) => {
        await reader.readCandidates(undefined, signal)
      })
      return { providerId, checkedAt, status: 'ready' }
    } catch (error) {
      signal.throwIfAborted()
      return {
        providerId,
        checkedAt,
        status: 'failed',
        reason:
          error instanceof TrackerProviderError
            ? `${error.code}: ${publicTrackerFailureMessage(error.code)}`
            : 'Provider check failed.',
      }
    }
  }

  private snapshot(query: OperationsQuery): OperationsSnapshot {
    const admission = this.ctx.admission.snapshot()
    const settings = this.ctx.autopilotConfig.get()
    const registrations = this.ctx.tracker.providerRegistrations()
    const names = providerNames(registrations)
    const filtered = admission.runs
      .map((run) => summaryOf(run, names, this.ctx.get('dispatch') !== undefined, this.ctx.autopilotWebContributions))
      .filter((run) => matchesQuery(run, query))
    const reconciliation = this.ctx.autopilotReconciliation.snapshot()
    const committed = admission.budget.settledTokens + admission.budget.reservedTokens
    return {
      revision: admission.revision,
      fetchedAt: new Date().toISOString(),
      scheduler: admission.scheduler,
      providers: providerViews(registrations, settings.trackerProvider, this.ctx.autopilotWebContributions),
      runs: {
        items: filtered.slice(query.offset, query.offset + query.limit),
        total: filtered.length,
        offset: query.offset,
        limit: query.limit,
      },
      budget: {
        deploymentCap: settings.deploymentTokenCap,
        settled: admission.budget.settledTokens,
        reserved: admission.budget.reservedTokens,
        remaining: admission.budget.usageUncertain ? null : Math.max(0, settings.deploymentTokenCap - committed),
        usageUncertain: admission.budget.usageUncertain,
      },
      schedule: {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        reconcileIntervalSeconds: settings.reconcileIntervalSeconds,
      },
      reconciliation: {
        active: reconciliation.active,
        ...(reconciliation.nextScheduledAt === undefined ? {} : { nextScheduledAt: reconciliation.nextScheduledAt }),
        ...(reconciliation.lastAttempt === undefined
          ? {}
          : {
              lastAttempt: {
                source: reconciliation.lastAttempt.source,
                completedAt: reconciliation.lastAttempt.completedAt,
                outcome: reconciliation.lastAttempt.outcome,
                admitted: reconciliation.lastAttempt.admitted,
                ...(reconciliation.lastAttempt.failure === undefined
                  ? {}
                  : { failure: reconciliation.lastAttempt.failure.message }),
              },
            }),
      },
      commands: this.commands.receipts(),
      integrations: integrationViews(this.ctx.autopilotWebContributions),
    }
  }
}

export default AutopilotWeb
