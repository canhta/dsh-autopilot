import { Button, IconSearchOutline16, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type {
  OperationsQuery,
  OperationsSnapshot,
  RunDetailView,
  RunLifecycle,
  RunSummaryView,
} from '../web/contract.js'
import { formatTime, Resource, RunStateLabel, Usage } from './OperationsAtoms.js'
import type { DetailState, OperationsPanelActions, Translate } from './OperationsPanel.js'
import css from './operations.module.css'

export function RunsView({
  snapshot,
  query,
  setQuery,
  runCommand,
  selectedRunId,
  setSelectedRunId,
  detail,
  commandsDisabled,
  t,
}: {
  readonly snapshot: OperationsSnapshot
  readonly query: OperationsQuery
  readonly setQuery: (patch: Partial<OperationsQuery>) => void
  readonly runCommand: OperationsPanelActions['runCommand']
  readonly selectedRunId: string | undefined
  readonly setSelectedRunId: (runId?: string) => void
  readonly detail: DetailState | undefined
  readonly commandsDisabled: boolean
  readonly t: Translate
}): ReactNode {
  const lifecycle = query.states?.[0] ?? ''
  return (
    <div className={selectedRunId === undefined ? css.runsOnly : css.split}>
      <section className={css.listRegion} aria-label={t('queueRuns')}>
        <div className={css.toolbar}>
          <Input
            icon={<IconSearchOutline16 />}
            aria-label={t('searchRuns')}
            placeholder={t('searchRuns')}
            value={query.search ?? ''}
            onChange={(event) => setQuery({ search: event.currentTarget.value })}
          />
          <select
            aria-label={t('state')}
            value={lifecycle}
            onChange={(event) => {
              const value = event.currentTarget.value as RunLifecycle | ''
              setQuery({ states: value === '' ? [] : [value] })
            }}
          >
            <option value="">{t('allStates')}</option>
            {visibleRunLifecycles.map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </select>
          <label className={css.checkbox}>
            <input
              type="checkbox"
              checked={query.attentionOnly === true}
              onChange={(event) => setQuery({ attentionOnly: event.currentTarget.checked })}
            />
            {t('attentionOnly')}
          </label>
          <span className={css.resultCount}>{t('results', { count: snapshot.runs.total })}</span>
        </div>
        {snapshot.runs.items.length === 0 ? (
          <div className={css.empty}>
            <p>{t('noRuns')}</p>
            <Button size="sm" onClick={() => setQuery({ search: '', states: [], attentionOnly: false })}>
              {t('clearFilters')}
            </Button>
          </div>
        ) : (
          <RunsTable runs={snapshot.runs.items} selectedRunId={selectedRunId} select={setSelectedRunId} t={t} />
        )}
      </section>
      {selectedRunId === undefined ? null : (
        <RunDetail
          detail={detail}
          close={() => setSelectedRunId(undefined)}
          runCommand={runCommand}
          commandsDisabled={commandsDisabled}
          t={t}
        />
      )}
    </div>
  )
}

function RunsTable({
  runs,
  selectedRunId,
  select,
  t,
}: {
  readonly runs: readonly RunSummaryView[]
  readonly selectedRunId: string | undefined
  readonly select: (id: string) => void
  readonly t: Translate
}): ReactNode {
  return (
    <div className={css.tableScroll}>
      <table className={css.table}>
        <thead>
          <tr>
            <th>{t('ticket')}</th>
            <th>{t('state')}</th>
            <th>{t('priority')}</th>
            <th>{t('phase')}</th>
            <th>{t('spend')}</th>
            <th>{t('updated')}</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.runId} data-selected={selectedRunId === run.runId ? 'true' : undefined}>
              <td>
                <button className={css.runLink} type="button" onClick={() => select(run.runId)}>
                  <strong>{run.displayKey}</strong>
                  <span title={run.summary}>{run.summary}</span>
                </button>
              </td>
              <td>
                <RunStateLabel run={run} />
              </td>
              <td className={css.numeric}>{run.priorityRank}</td>
              <td>{run.phase}</td>
              <td className={css.numeric}>
                <Usage run={run} t={t} />
              </td>
              <td>
                <time dateTime={run.updatedAt}>{formatTime(run.updatedAt)}</time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RunDetail({
  detail,
  close,
  runCommand,
  commandsDisabled,
  t,
}: {
  readonly detail: DetailState | undefined
  readonly close: () => void
  readonly runCommand: OperationsPanelActions['runCommand']
  readonly commandsDisabled: boolean
  readonly t: Translate
}): ReactNode {
  return (
    <aside className={css.detail} aria-label={t('selectedRun')}>
      <Button size="sm" onClick={close}>
        {t('backToRuns')}
      </Button>
      {detail === undefined || detail.status === 'loading' ? (
        <p>{t('loading')}</p>
      ) : detail.status === 'error' ? (
        <p>{t('unavailable')}</p>
      ) : (
        <RunDetailContent run={detail.value} runCommand={runCommand} commandsDisabled={commandsDisabled} t={t} />
      )}
    </aside>
  )
}

function RunDetailContent({
  run,
  runCommand,
  commandsDisabled,
  t,
}: {
  readonly run: RunDetailView
  readonly runCommand: OperationsPanelActions['runCommand']
  readonly commandsDisabled: boolean
  readonly t: Translate
}): ReactNode {
  return (
    <>
      <div className={css.detailHeader}>
        <div>
          <h2>{run.displayKey}</h2>
          <p>{run.summary}</p>
        </div>
        <RunStateLabel run={run} />
      </div>
      {run.lifecycle === 'blocked' ? (
        <div className={css.blocker}>
          <strong>{t('waitingHuman', { tracker: run.providerName })}</strong>
          <p>{run.reason}</p>
        </div>
      ) : (
        <p className={css.reason}>{run.reason}</p>
      )}
      <div className={css.detailActions}>
        {run.actions.map((action) => (
          <Button
            key={action}
            variant="outline"
            size="sm"
            disabled={commandsDisabled}
            onClick={() => void runCommand(action, { runId: run.runId })}
          >
            {t(runActionLabels[action])}
          </Button>
        ))}
      </div>
      <details open>
        <summary>{t('brief')}</summary>
        <p className={css.longText}>{run.brief.content}</p>
      </details>
      {run.outcome === undefined ? null : (
        <details open>
          <summary>{t('outcome')}</summary>
          <p>{run.outcome.summary}</p>
          <ul>
            {run.outcome.evidence.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </details>
      )}
      <details open>
        <summary>{t('timeline')}</summary>
        <ol className={css.timeline}>
          {run.timeline.map((entry) => (
            <li key={`${entry.at}:${entry.label}`}>
              <time dateTime={entry.at}>{formatTime(entry.at)}</time>
              <strong>{entry.label}</strong>
              {entry.detail === undefined ? null : <span>{entry.detail}</span>}
            </li>
          ))}
        </ol>
      </details>
      <details>
        <summary>{t('resources')}</summary>
        <Resource label={t('ticket')} value={run.ticket.status === 'available' ? run.ticket.url : run.ticket.reason} />
        <Resource
          label="PR"
          value={run.pullRequest.status === 'available' ? run.pullRequest.url : run.pullRequest.reason}
        />
        {run.worktree === undefined ? null : <Resource label={t('worktree')} value={run.worktree.path} mono />}
      </details>
    </>
  )
}

const runActionLabels = {
  'pause-run': 'pauseRun',
  'resume-run': 'resumeRun',
  'cancel-run': 'cancelRun',
} as const

const visibleRunLifecycles = [
  'queued',
  'implementing',
  'pausing',
  'paused',
  'publishing',
  'completed',
  'blocked',
  'failed',
  'cancelled',
] satisfies readonly RunLifecycle[]
