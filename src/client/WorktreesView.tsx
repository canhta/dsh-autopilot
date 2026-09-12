import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { type ReactNode, useEffect, useState } from 'react'
import type { CleanupPreviewView, OperationsSnapshot, RunSummaryView, WorktreeView } from '../web/contract.js'
import type { OperationsPanelActions, Translate } from './OperationsPanel.js'
import css from './operations.module.css'

type Inspection =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: WorktreeView | null }
  | { readonly status: 'error' }

export function WorktreesView({
  snapshot,
  actions,
  pending,
  t,
}: {
  readonly snapshot: OperationsSnapshot
  readonly actions: OperationsPanelActions
  readonly pending: boolean
  readonly t: Translate
}): ReactNode {
  const rows = snapshot.runs.items.filter((run) => run.worktree !== undefined)
  return (
    <section className={css.summary}>
      <h2>{t('worktrees')}</h2>
      {snapshot.integrations.worktrees.status === 'unavailable' ? (
        <p className={css.attention}>{snapshot.integrations.worktrees.reason}</p>
      ) : null}
      {rows.length === 0 ? (
        <p>{t('noWorktrees')}</p>
      ) : (
        <ul className={css.worktreeList}>
          {rows.map((run) => (
            <WorktreeRow key={run.runId} run={run} actions={actions} pending={pending} t={t} />
          ))}
        </ul>
      )}
    </section>
  )
}

function WorktreeRow({
  run,
  actions,
  pending,
  t,
}: {
  readonly run: RunSummaryView
  readonly actions: OperationsPanelActions
  readonly pending: boolean
  readonly t: Translate
}): ReactNode {
  const [inspection, setInspection] = useState<Inspection>({ status: 'loading' })
  const [preview, setPreview] = useState<CleanupPreviewView>()
  const [previewing, setPreviewing] = useState(false)

  useEffect(() => {
    if (pending) return
    let current = true
    const request = new AbortController()
    setInspection({ status: 'loading' })
    void actions.inspectWorktree(run.runId, request.signal).then(
      (value) => {
        if (current) {
          setInspection({ status: 'ready', value })
          if (value === null) setPreview(undefined)
        }
      },
      () => {
        if (current) setInspection({ status: 'error' })
      },
    )
    return () => {
      current = false
      request.abort()
    }
  }, [actions, run.runId, pending])

  const worktree = inspection.status === 'ready' ? inspection.value : run.worktree
  const cleanup = worktree?.cleanup
  const eligible = cleanup?.status === 'available' && cleanup.eligible
  const message =
    inspection.status === 'error'
      ? t('inspectFailed')
      : cleanup?.status === 'available'
        ? cleanup.eligible
          ? t('cleanupPreviewReady')
          : cleanup.rejections.join(', ')
        : cleanup?.reason

  const createPreview = async () => {
    setPreviewing(true)
    try {
      setPreview((await actions.previewCleanup(run.runId)) ?? undefined)
    } catch {
      setInspection({ status: 'error' })
    } finally {
      setPreviewing(false)
    }
  }

  return (
    <li>
      <div>
        <strong>{run.displayKey}</strong>
        <code>{worktree?.branch}</code>
        <code>{worktree?.path}</code>
        <span>{message}</span>
      </div>
      <Tag tone={eligible ? 'warning' : 'neutral'}>{eligible ? t('cleanupPreviewReady') : t('cleanupUnavailable')}</Tag>
      {eligible && preview === undefined ? (
        <Button size="sm" variant="outline" disabled={pending || previewing} onClick={() => void createPreview()}>
          {t('previewCleanup')}
        </Button>
      ) : null}
      {preview?.cleanup.status === 'available' && preview.cleanup.eligible ? (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void actions.runCommand('remove-worktree', { previewId: preview.previewId })}
        >
          {t('removeWorktree')}
        </Button>
      ) : null}
    </li>
  )
}
