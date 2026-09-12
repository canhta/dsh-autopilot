import {
  Button,
  IconPauseOutline16,
  IconPlayOutline16,
  IconRefreshOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { type KeyboardEvent, type ReactNode, useEffect, useState } from 'react'
import type {
  CleanupPreviewView,
  CommandKind,
  CommandRequest,
  OperationsQuery,
  OperationsSnapshot,
  RunDetailView,
  WorktreeView,
} from '../web/contract.js'
import type { AutopilotLocaleKey } from './locales/index.js'
import { CommandFeedback, QueryFallback, SchedulerTag } from './OperationsAtoms.js'
import css from './operations.module.css'
import { RunsView } from './RunsView.js'
import { SummaryView } from './SummaryView.js'
import type { OperationsClientState } from './state.js'

export interface OperationsPanelActions {
  connect(): () => void
  refresh(): Promise<void>
  setQuery(patch: Partial<OperationsQuery>): void
  loadRun(runId: string, signal?: AbortSignal): Promise<RunDetailView | null>
  inspectWorktree(runId: string, signal?: AbortSignal): Promise<WorktreeView | null>
  previewCleanup(runId: string, signal?: AbortSignal): Promise<CleanupPreviewView | null>
  runCommand(kind: CommandKind, target?: Pick<CommandRequest, 'runId' | 'deliveryId' | 'previewId'>): Promise<void>
}

export interface OperationsPanelInjected {
  readonly actions: OperationsPanelActions
  readonly hooks: {
    readonly operations: { getSnapshot(): OperationsClientState; subscribe(listener: () => void): () => void }
  }
}

export type OperationsPanelProps = PropsRuntime<'main'> & PropsLocale<'autopilot'> & InjectFace<OperationsPanelInjected>
export type Translate = OperationsPanelProps['t']
export type DetailState = { status: 'loading' } | { status: 'ready'; value: RunDetailView } | { status: 'error' }
type TabId = 'runs' | 'schedule' | 'budget' | 'notifications' | 'worktrees'

const tabs: ReadonlyArray<{ id: TabId; label: AutopilotLocaleKey }> = [
  { id: 'runs', label: 'queueRuns' },
  { id: 'schedule', label: 'schedule' },
  { id: 'budget', label: 'budget' },
  { id: 'notifications', label: 'notifications' },
  { id: 'worktrees', label: 'worktrees' },
]

/** Slot adapter: subscribe once, then pass data and callbacks into the Operations presentation modules. */
export function OperationsPanel({ actions, useOperations, t }: OperationsPanelProps): ReactNode {
  const state = useOperations((value) => value)
  const [tab, setTab] = useState<TabId>('runs')
  const [selectedRunId, setSelectedRunId] = useState<string>()
  const [detail, setDetail] = useState<DetailState>()
  useEffect(() => actions.connect(), [actions])
  useEffect(() => {
    if (selectedRunId === undefined) return setDetail(undefined)
    let current = true
    const request = new AbortController()
    setDetail({ status: 'loading' })
    void actions.loadRun(selectedRunId, request.signal).then(
      (value) => {
        if (current) setDetail(value === null ? { status: 'error' } : { status: 'ready', value })
      },
      () => {
        if (current) setDetail({ status: 'error' })
      },
    )
    return () => {
      current = false
      request.abort()
    }
  }, [actions, selectedRunId])

  const snapshot = 'data' in state.operations ? state.operations.data : undefined
  const pending = commandPending(state) || state.connection !== 'connected'
  const selectedProvider = snapshot?.providers.find((provider) => provider.selected)
  const attentionCount =
    (snapshot?.runs.items.filter((run) => run.attention).length ?? 0) +
    (selectedProvider?.availability === 'unavailable' ? 1 : 0)

  return (
    <main className={css.page} aria-labelledby="autopilot-title">
      <header className={css.header}>
        <div>
          <h1 id="autopilot-title">{t('panelTitle')}</h1>
          <p>{t('panelDescription')}</p>
        </div>
        <div className={css.headerActions}>
          {snapshot === undefined ? null : <SchedulerTag mode={snapshot.scheduler.mode} t={t} />}
          {snapshot?.scheduler.mode === 'enabled' ? (
            <Button
              variant="primary"
              size="sm"
              icon={<IconPauseOutline16 />}
              disabled={pending}
              onClick={() => void actions.runCommand('pause-scheduler')}
            >
              {t('pauseScheduler')}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              icon={<IconPlayOutline16 />}
              disabled={pending}
              onClick={() => void actions.runCommand('resume-scheduler')}
            >
              {t('resumeScheduler')}
            </Button>
          )}
          <Button size="sm" variant="outline" icon={<IconRefreshOutline16 />} onClick={() => void actions.refresh()}>
            {t('refresh')}
          </Button>
        </div>
      </header>
      {state.connection === 'disconnected' || state.connection === 'connecting' ? (
        <div className={css.connectionNotice} role="status">
          <strong>{t('disconnected')}</strong> · {t('stale')}
        </div>
      ) : null}
      {attentionCount > 0 ? (
        <div className={css.attention} role="status">
          {t('attention', { count: attentionCount })}
        </div>
      ) : null}
      <CommandFeedback state={state} t={t} />
      <div className={css.tabs} role="tablist" aria-label={t('panelTitle')}>
        {tabs.map((item, index) => (
          <button
            key={item.id}
            id={`autopilot-tab-control-${item.id}`}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`autopilot-tab-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            className={tab === item.id ? css.activeTab : undefined}
            onClick={() => setTab(item.id)}
            onKeyDown={(event) => selectTabWithKeyboard(event, index, setTab)}
          >
            {t(item.label)}
          </button>
        ))}
      </div>
      <section
        id={`autopilot-tab-${tab}`}
        role="tabpanel"
        aria-labelledby={`autopilot-tab-control-${tab}`}
        className={css.content}
      >
        {snapshot === undefined ? (
          <QueryFallback state={state.operations} retry={actions.refresh} t={t} />
        ) : tab === 'runs' ? (
          <RunsView
            snapshot={snapshot}
            query={state.query}
            setQuery={actions.setQuery}
            runCommand={actions.runCommand}
            selectedRunId={selectedRunId}
            setSelectedRunId={setSelectedRunId}
            detail={detail}
            commandsDisabled={pending}
            t={t}
          />
        ) : (
          <SummaryView tab={tab} snapshot={snapshot} actions={actions} pending={pending} t={t} />
        )}
      </section>
      {snapshot === undefined ? null : (
        <PageControls snapshot={snapshot} setQuery={actions.setQuery} pending={pending} t={t} />
      )}
    </main>
  )
}

function PageControls({
  snapshot,
  setQuery,
  pending,
  t,
}: {
  readonly snapshot: OperationsSnapshot
  readonly setQuery: OperationsPanelActions['setQuery']
  readonly pending: boolean
  readonly t: Translate
}): ReactNode {
  const { offset, limit, total } = snapshot.runs
  if (offset === 0 && total <= limit) return null
  const page = Math.floor(offset / limit) + 1
  const pages = Math.max(1, Math.ceil(total / limit))
  return (
    <nav className={css.detailActions} aria-label={t('pagination')}>
      <Button
        size="sm"
        variant="outline"
        disabled={pending || offset === 0}
        onClick={() => setQuery({ offset: Math.max(0, offset - limit) })}
      >
        {t('previousPage')}
      </Button>
      <span>{t('pageOf', { page, pages })}</span>
      <Button
        size="sm"
        variant="outline"
        disabled={pending || offset + limit >= total}
        onClick={() => setQuery({ offset: offset + limit })}
      >
        {t('nextPage')}
      </Button>
    </nav>
  )
}

function selectTabWithKeyboard(
  event: KeyboardEvent<HTMLButtonElement>,
  currentIndex: number,
  select: (tab: TabId) => void,
): void {
  const nextIndex =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : event.key === 'ArrowRight'
          ? (currentIndex + 1) % tabs.length
          : event.key === 'ArrowLeft'
            ? (currentIndex - 1 + tabs.length) % tabs.length
            : undefined
  if (nextIndex === undefined) return
  event.preventDefault()
  const next = tabs[nextIndex]
  if (next === undefined) return
  select(next.id)
  document.getElementById(`autopilot-tab-control-${next.id}`)?.focus()
}

function commandPending(state: OperationsClientState): boolean {
  return (
    state.command?.status === 'pending' ||
    state.command?.status === 'accepted' ||
    state.command?.status === 'in-progress'
  )
}
