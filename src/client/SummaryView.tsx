import { Button, IconGaugeOutline16, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { OperationsSnapshot } from '../web/contract.js'
import { formatTime } from './OperationsAtoms.js'
import type { OperationsPanelActions, Translate } from './OperationsPanel.js'
import css from './operations.module.css'
import { WorktreesView } from './WorktreesView.js'

export function SummaryView({
  tab,
  snapshot,
  actions,
  pending,
  t,
}: {
  readonly tab: 'schedule' | 'budget' | 'notifications' | 'worktrees'
  readonly snapshot: OperationsSnapshot
  readonly actions: OperationsPanelActions
  readonly pending: boolean
  readonly t: Translate
}): ReactNode {
  if (tab === 'schedule')
    return <ScheduleView snapshot={snapshot} runCommand={actions.runCommand} pending={pending} t={t} />
  if (tab === 'budget') return <BudgetView snapshot={snapshot} t={t} />
  if (tab === 'notifications')
    return <NotificationsView snapshot={snapshot} runCommand={actions.runCommand} pending={pending} t={t} />
  return <WorktreesView snapshot={snapshot} actions={actions} pending={pending} t={t} />
}

function ScheduleView({
  snapshot,
  runCommand,
  pending,
  t,
}: {
  readonly snapshot: OperationsSnapshot
  readonly runCommand: OperationsPanelActions['runCommand']
  readonly pending: boolean
  readonly t: Translate
}): ReactNode {
  return (
    <section className={css.summary}>
      <h2>{t('schedule')}</h2>
      <dl>
        <div>
          <dt>{t('scheduleTimezone')}</dt>
          <dd>{snapshot.schedule.timezone}</dd>
        </div>
        <div>
          <dt>{t('reconcileEvery', { seconds: snapshot.schedule.reconcileIntervalSeconds })}</dt>
          <dd>
            {snapshot.reconciliation.nextScheduledAt === undefined
              ? t('noReconcile')
              : formatTime(snapshot.reconciliation.nextScheduledAt)}
          </dd>
        </div>
      </dl>
      <div className={css.detailActions}>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => void runCommand('reconcile')}>
          {t('reconcileNow')}
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => void runCommand('drain')}>
          {t('drainScheduler')}
        </Button>
      </div>
    </section>
  )
}

function BudgetView({ snapshot, t }: { readonly snapshot: OperationsSnapshot; readonly t: Translate }): ReactNode {
  return (
    <section className={css.summary}>
      <h2>{t('budget')}</h2>
      <dl>
        <div>
          <dt>{t('cap')}</dt>
          <dd>{snapshot.budget.deploymentCap}</dd>
        </div>
        <div>
          <dt>{t('settled')}</dt>
          <dd>{snapshot.budget.settled}</dd>
        </div>
        <div>
          <dt>{t('reserved')}</dt>
          <dd>{snapshot.budget.reserved}</dd>
        </div>
        <div>
          <dt>{t('remaining')}</dt>
          <dd>{snapshot.budget.remaining ?? t('unknownRemaining')}</dd>
        </div>
      </dl>
    </section>
  )
}

function NotificationsView({
  snapshot,
  runCommand,
  pending,
  t,
}: {
  readonly snapshot: OperationsSnapshot
  readonly runCommand: OperationsPanelActions['runCommand']
  readonly pending: boolean
  readonly t: Translate
}): ReactNode {
  const deliveries = snapshot.runs.items.flatMap((run) =>
    run.deliveries.filter((delivery) => delivery.kind === 'notification').map((delivery) => ({ run, delivery })),
  )
  if (snapshot.integrations.deliveries.status === 'unavailable')
    return <EmptyIntegration title={t('notifications')} body={snapshot.integrations.deliveries.reason} />
  return (
    <section className={css.summary}>
      <h2>{t('notifications')}</h2>
      {deliveries.length === 0 ? (
        <p>{t('noDeliveries')}</p>
      ) : (
        <ul className={css.worktreeList}>
          {deliveries.map(({ run, delivery }) => (
            <li key={delivery.id}>
              <div>
                <strong>{run.displayKey}</strong>
                <span>{delivery.destination}</span>
                <span>{delivery.lastError}</span>
              </div>
              <Tag
                tone={
                  delivery.status === 'succeeded'
                    ? 'success'
                    : ['uncertain', 'retryable-failure', 'exhausted', 'permanent-failure'].includes(delivery.status)
                      ? 'danger'
                      : 'neutral'
                }
              >
                {delivery.status}
              </Tag>
              {delivery.retryable ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void runCommand('retry-delivery', { deliveryId: delivery.id })}
                >
                  {t('retry')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function EmptyIntegration({ title, body }: { readonly title: string; readonly body: string }): ReactNode {
  return (
    <section className={css.empty}>
      <IconGaugeOutline16 aria-hidden="true" />
      <h2>{title}</h2>
      <p>{body}</p>
    </section>
  )
}
