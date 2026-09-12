import { Button, Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { OperationsSnapshot, RunSummaryView } from '../web/contract.js'
import type { Translate } from './OperationsPanel.js'
import css from './operations.module.css'
import type { OperationsClientState, QueryState } from './state.js'

export function QueryFallback({
  state,
  retry,
  t,
}: {
  readonly state: QueryState<OperationsSnapshot>
  readonly retry: () => Promise<void>
  readonly t: Translate
}): ReactNode {
  if (state.status === 'loading') return <p role="status">{t('loading')}</p>
  return (
    <div className={css.empty}>
      <p>{state.status === 'error' ? state.message : t('unavailable')}</p>
      <Button onClick={() => void retry()}>{t('retry')}</Button>
    </div>
  )
}

export function CommandFeedback({
  state,
  t,
}: {
  readonly state: OperationsClientState
  readonly t: Translate
}): ReactNode {
  const command = state.command
  if (command === undefined) return null
  const key =
    command.status === 'pending'
      ? 'commandPending'
      : command.status === 'accepted'
        ? 'commandAccepted'
        : command.status === 'in-progress'
          ? 'commandProgress'
          : command.status === 'succeeded'
            ? 'commandSucceeded'
            : 'commandRejected'
  return (
    <div className={css.command} role="status" aria-live="polite">
      {t(key)}
      {'message' in command && command.message !== undefined ? ` ${command.message}` : ''}
    </div>
  )
}

export function SchedulerTag({
  mode,
  t,
}: {
  readonly mode: OperationsSnapshot['scheduler']['mode']
  readonly t: Translate
}): ReactNode {
  return (
    <Tag tone={mode === 'enabled' ? 'success' : mode === 'draining' ? 'warning' : 'neutral'}>
      {t(mode === 'enabled' ? 'schedulerEnabled' : mode === 'draining' ? 'schedulerDraining' : 'schedulerDisabled')}
    </Tag>
  )
}

export function RunStateLabel({ run }: { readonly run: RunSummaryView }): ReactNode {
  const tones: Record<RunSummaryView['lifecycle'], TagTone> = {
    queued: 'neutral',
    implementing: 'info',
    pausing: 'warning',
    paused: 'neutral',
    publishing: 'info',
    completed: 'success',
    blocked: 'warning',
    failed: 'danger',
    cancelled: 'neutral',
  }
  return (
    <span className={css.stateLabel}>
      <Tag tone={tones[run.lifecycle]}>{run.lifecycle}</Tag>
      <span>{run.reason}</span>
    </span>
  )
}

export function Usage({ run, t }: { readonly run: RunSummaryView; readonly t: Translate }): ReactNode {
  return run.usage.kind === 'unknown' ? (
    <span title={run.usage.reason}>{t('unknown')}</span>
  ) : (
    <span>{t('reservedSettled', { settled: run.usage.settled, reserved: run.usage.reserved })}</span>
  )
}

export function Resource({
  label,
  value,
  mono = false,
}: {
  readonly label: string
  readonly value: string
  readonly mono?: boolean
}): ReactNode {
  return (
    <div className={css.resource}>
      <strong>{label}</strong>
      {mono ? <code>{value}</code> : <span>{value}</span>}
    </div>
  )
}

export function formatTime(value: string): string {
  return new Date(value).toLocaleString()
}
