import type { AutopilotRun } from '../admission.js'
import type { TrackerProviderRegistration } from '../tracker.js'
import type {
  OperationsQuery,
  OperationsSnapshot,
  ProviderView,
  RunDetailView,
  RunSummaryView,
  TimelineEntryView,
} from './contract.js'
import type { AutopilotWebContributions } from './contributions.js'

export function providerNames(registrations: readonly TrackerProviderRegistration[]): ReadonlyMap<string, string> {
  return new Map(registrations.map((provider) => [provider.id, provider.displayName]))
}

export async function providerViews(
  registrations: readonly TrackerProviderRegistration[],
  selectedId: string,
  contributions: AutopilotWebContributions,
  signal?: AbortSignal,
): Promise<ProviderView[]> {
  const registeredIds = new Set(registrations.map(({ id }) => String(id)))
  const views: ProviderView[] = await Promise.all(
    contributions.providerViews().map(async (provider) => ({
      id: provider.providerId,
      displayName: provider.displayName,
      configurationNamespace: provider.configurationNamespace,
      selected: provider.providerId === selectedId,
      availability: registeredIds.has(provider.providerId) ? 'available' : 'unavailable',
      setup: await provider.view(signal),
    })),
  )
  for (const provider of registrations)
    if (!views.some(({ id }) => id === provider.id))
      views.push({
        id: provider.id,
        displayName: provider.displayName,
        configurationNamespace: provider.configurationNamespace,
        selected: provider.id === selectedId,
        availability: 'available',
        setup: { status: 'unavailable', reason: 'This provider does not publish a browser-safe setup view.' },
      })
  if (!views.some(({ id }) => id === selectedId))
    views.unshift({
      id: selectedId,
      displayName: selectedId,
      configurationNamespace: '',
      selected: true,
      availability: 'unavailable',
      setup: { status: 'unavailable', reason: 'The selected provider is not installed in this DSH composition.' },
    })
  return views
}

export function summaryOf(
  run: AutopilotRun,
  providers: ReadonlyMap<string, string>,
  dispatchAvailable: boolean,
  contributions: AutopilotWebContributions,
): RunSummaryView {
  const execution = 'execution' in run ? run.execution : undefined
  const deliveries = contributions.deliveriesFor(run.runId)
  const usage =
    'budget' in run && run.budget.usageUncertain
      ? { kind: 'unknown' as const, reason: run.budget.usageUncertaintyReason ?? 'Usage settlement is uncertain.' }
      : {
          kind: 'known' as const,
          settled: 'budget' in run ? run.budget.settledTokens : 0,
          reserved: 'budget' in run ? run.budget.reservedTokens : 0,
        }
  const unknownLink = (reason: string) => ({ status: 'unknown' as const, reason })
  return {
    runId: run.runId,
    displayKey: run.displayKey,
    summary: run.summary,
    providerId: run.providerId,
    providerName: providers.get(run.providerId) ?? run.providerId,
    lifecycle: run.state,
    reason: reasonOf(run),
    priorityRank: run.priorityRank,
    phase: phaseOf(run),
    queuedAt: run.queuedAt,
    updatedAt: updatedAtOf(run),
    attention:
      run.state === 'blocked' ||
      run.state === 'failed' ||
      deliveries.some((delivery) =>
        ['uncertain', 'retryable-failure', 'exhausted', 'permanent-failure'].includes(delivery.status),
      ) ||
      ('recovery' in (execution ?? {}) && execution?.recovery !== undefined),
    usage,
    ticket: unknownLink('The tracker provider has not supplied a browser URL.'),
    session: unknownLink('The DSH Session shortcut is not available in this Host contract yet.'),
    pullRequest:
      'publication' in run && run.publication?.receipt !== undefined
        ? {
            status: 'available',
            url: run.publication.receipt.url,
            label: `PR #${String(run.publication.receipt.number)}`,
          }
        : unknownLink('No confirmed pull-request receipt is available for this run.'),
    deliveries,
    actions: actionsOf(run, dispatchAvailable),
    ...(execution === undefined
      ? {}
      : {
          worktree: {
            path: execution.worktreePath,
            branch: execution.branch,
            ...(execution.git?.head === undefined ? {} : { head: execution.git.head }),
            state: 'unknown',
            dirty: { status: 'unknown', reason: 'No worktree inspection contribution is mounted.' },
            untracked: { status: 'unknown', reason: 'No worktree inspection contribution is mounted.' },
            unpushed: { status: 'unknown', reason: 'No worktree inspection contribution is mounted.' },
            pullRequestDisposition: 'unknown',
            cleanup: {
              status: 'unavailable',
              reason: 'No worktree maintenance contribution is mounted; destructive actions are disabled.',
            },
          },
        }),
  }
}

export function detailOf(
  run: AutopilotRun,
  providers: ReadonlyMap<string, string>,
  dispatchAvailable: boolean,
  contributions: AutopilotWebContributions,
): RunDetailView {
  return {
    ...summaryOf(run, providers, dispatchAvailable, contributions),
    brief: { updatedAt: run.brief.updatedAt, content: run.brief.content },
    ...('outcome' in run ? { outcome: run.outcome } : {}),
    timeline: timelineOf(run),
  }
}

export function integrationViews(contributions: AutopilotWebContributions): OperationsSnapshot['integrations'] {
  const available = contributions.availability()
  return {
    deliveries: available.deliveries
      ? { status: 'available' }
      : { status: 'unavailable', reason: 'No delivery contribution is mounted.' },
    worktrees: available.worktrees
      ? { status: 'available' }
      : { status: 'unavailable', reason: 'No worktree maintenance contribution is mounted; cleanup remains disabled.' },
  }
}

export function matchesQuery(run: RunSummaryView, query: OperationsQuery): boolean {
  const normalized = query.search?.trim().toLocaleLowerCase() ?? ''
  return (
    (normalized === '' || `${run.displayKey} ${run.summary}`.toLocaleLowerCase().includes(normalized)) &&
    (query.states === undefined || query.states.length === 0 || query.states.includes(run.lifecycle)) &&
    (query.attentionOnly !== true || run.attention)
  )
}

function timelineOf(run: AutopilotRun): TimelineEntryView[] {
  const entries: TimelineEntryView[] = [{ at: run.queuedAt, label: 'Admitted to queue' }]
  if ('execution' in run) entries.push({ at: run.execution.startedAt, label: 'Execution started' })
  if ('pause' in run)
    entries.push({
      at: run.pause.kind === 'active' ? run.pause.requestedAt : run.pause.pausedAt,
      label: run.state === 'pausing' ? 'Checkpoint requested' : 'Paused',
      detail: run.pause.reason,
    })
  if ('completedAt' in run)
    entries.push({ at: run.completedAt, label: 'Execution completed', detail: run.outcome.summary })
  if (run.state === 'cancelled') {
    entries.push({
      at: run.cancellation.cancelledAt,
      label: 'Run cancelled',
      detail: 'Operator ended this quiescent run; retained resources and delivery history were preserved.',
    })
  }
  return entries.sort((left, right) => left.at.localeCompare(right.at))
}

function reasonOf(run: AutopilotRun): string {
  if (run.state === 'queued') return 'Waiting for dispatch'
  if (run.state === 'implementing') return run.execution.recovery?.reason ?? 'Implementing'
  if (run.state === 'pausing') return `Checkpoint requested: ${run.pause.reason}`
  if (run.state === 'paused') return `Operational pause: ${run.pause.reason}`
  if (run.state === 'publishing') return 'Verified locally; pull-request publication is pending'
  if (run.state === 'blocked') return `Waiting for a human in the tracker: ${run.outcome.summary}`
  if (run.state === 'cancelled') return 'Cancelled by operator'
  return run.outcome.summary
}

function phaseOf(run: AutopilotRun): string {
  if (run.state === 'queued') return 'Queue'
  if (run.state === 'implementing' || run.state === 'pausing' || run.state === 'paused') return 'Execution'
  if (run.state === 'publishing') return 'Publication'
  return 'Outcome'
}
function updatedAtOf(run: AutopilotRun): string {
  if (run.state === 'cancelled') return run.cancellation.cancelledAt
  if ('completedAt' in run) return run.completedAt
  if ('pause' in run)
    return run.pause.kind === 'active'
      ? 'pausedAt' in run.pause
        ? run.pause.pausedAt
        : run.pause.requestedAt
      : run.pause.pausedAt
  if ('execution' in run) return run.execution.startedAt
  return run.queuedAt
}
function actionsOf(run: AutopilotRun, dispatchAvailable: boolean): RunSummaryView['actions'] {
  if (run.state === 'queued') return ['pause-run', 'cancel-run']
  if (run.state === 'implementing' || run.state === 'pausing') return dispatchAvailable ? ['pause-run'] : []
  if (run.state === 'paused') return ['resume-run', 'cancel-run']
  if (run.state === 'blocked') return ['cancel-run']
  return []
}
