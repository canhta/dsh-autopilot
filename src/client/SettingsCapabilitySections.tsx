import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { type ReactNode, useId } from 'react'
import type { NotificationEvent } from '../notification.js'
import css from './settings.module.css'
import type { AutopilotTranslate, NotificationSubscriptionDraft, SettingsDraft } from './settings-draft.js'

type ChangeSetting = <K extends keyof SettingsDraft>(field: K, value: SettingsDraft[K]) => void

const notificationEvents: readonly NotificationEvent['type'][] = ['started', 'blocked', 'paused', 'failed', 'completed']

export function NotificationSection({
  draft,
  reason,
  onChange,
  t,
}: {
  readonly draft: SettingsDraft
  readonly reason: string | undefined
  readonly onChange: ChangeSetting
  readonly t: AutopilotTranslate
}): ReactNode {
  const update = (index: number, next: NotificationSubscriptionDraft): void => {
    onChange(
      'notificationSubscriptions',
      draft.notificationSubscriptions.map((subscription, candidate) => (candidate === index ? next : subscription)),
    )
  }
  return (
    <fieldset>
      <legend>{t('notificationsSection')}</legend>
      <p className={css.fullWidth}>{t('notificationOwnership')}</p>
      {reason === undefined ? null : <p className={`${css.notice} ${css.fullWidth}`}>{reason}</p>}
      <TextField
        label={t('runUrlTemplate')}
        value={draft.runUrlTemplate}
        placeholder="https://…/{runId}"
        onChange={(value) => onChange('runUrlTemplate', value)}
      />
      <TextField
        label={t('issueUrlTemplate')}
        value={draft.issueUrlTemplate}
        placeholder="https://…/{displayKey}"
        onChange={(value) => onChange('issueUrlTemplate', value)}
      />
      <div className={`${css.notificationList} ${css.fullWidth}`}>
        {draft.notificationSubscriptions.map((subscription, index) => (
          <NotificationRow
            key={subscription.draftId}
            index={index}
            value={subscription}
            onChange={(value) => update(index, value)}
            onRemove={() =>
              onChange(
                'notificationSubscriptions',
                draft.notificationSubscriptions.filter((_, candidate) => candidate !== index),
              )
            }
            t={t}
          />
        ))}
        {draft.notificationSubscriptions.length === 0 ? <p>{t('noNotificationSubscriptions')}</p> : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            onChange('notificationSubscriptions', [
              ...draft.notificationSubscriptions,
              {
                draftId: crypto.randomUUID(),
                providerId: '',
                destinationId: '',
                events: ['failed'],
                summaryDisclosure: 'redacted',
              },
            ])
          }
        >
          {t('addNotificationDestination')}
        </Button>
      </div>
    </fieldset>
  )
}

function NotificationRow({
  index,
  value,
  onChange,
  onRemove,
  t,
}: {
  readonly index: number
  readonly value: NotificationSubscriptionDraft
  readonly onChange: (value: NotificationSubscriptionDraft) => void
  readonly onRemove: () => void
  readonly t: AutopilotTranslate
}): ReactNode {
  const toggleEvent = (event: NotificationEvent['type']): void => {
    onChange({
      ...value,
      events: value.events.includes(event)
        ? value.events.filter((candidate) => candidate !== event)
        : [...value.events, event],
    })
  }
  return (
    <article className={css.notificationRow} aria-label={t('notificationDestinationNumber', { number: index + 1 })}>
      <TextField
        label={t('notificationProviderReference')}
        value={value.providerId}
        onChange={(providerId) => onChange({ ...value, providerId })}
      />
      <TextField
        label={t('notificationDestinationReference')}
        value={value.destinationId}
        onChange={(destinationId) => onChange({ ...value, destinationId })}
      />
      <label>
        {t('summaryDisclosure')}
        <select
          value={value.summaryDisclosure}
          onChange={(event) =>
            onChange({ ...value, summaryDisclosure: event.currentTarget.value as 'redacted' | 'full' })
          }
        >
          <option value="redacted">{t('redactedDisclosure')}</option>
          <option value="full">{t('fullDisclosure')}</option>
        </select>
      </label>
      <fieldset className={css.eventChoices}>
        <legend>{t('notificationEvents')}</legend>
        {notificationEvents.map((event) => (
          <label key={event} className={css.checkboxLabel}>
            <input type="checkbox" checked={value.events.includes(event)} onChange={() => toggleEvent(event)} />
            {t(`notificationEvent_${event}`)}
          </label>
        ))}
      </fieldset>
      <Button size="sm" variant="outline" onClick={onRemove}>
        {t('removeNotificationDestination')}
      </Button>
    </article>
  )
}

export function RetentionStorageSection({
  draft,
  reason,
  onChange,
  t,
}: {
  readonly draft: SettingsDraft
  readonly reason: string | undefined
  readonly onChange: ChangeSetting
  readonly t: AutopilotTranslate
}): ReactNode {
  const cleanupRetentionId = useId()
  return (
    <fieldset>
      <legend>{t('retentionSection')}</legend>
      {reason === undefined ? null : <p className={`${css.notice} ${css.fullWidth}`}>{reason}</p>}
      <label htmlFor={cleanupRetentionId}>
        {t('cleanupRetentionDays')}
        <Input
          id={cleanupRetentionId}
          type="number"
          inputMode="numeric"
          min={0}
          max={3650}
          step={1}
          value={draft.cleanupRetentionDays}
          onChange={(event) => onChange('cleanupRetentionDays', event.currentTarget.value)}
        />
      </label>
      <label className={`${css.checkboxLabel} ${css.fullWidth}`}>
        <input
          type="checkbox"
          checked={draft.autoCleanupEnabled}
          onChange={(event) => onChange('autoCleanupEnabled', event.currentTarget.checked)}
        />
        {t('autoCleanupEnabled')}
      </label>
      <p className={`${css.fullWidth} ${css.notice}`}>{t('cleanupSafetyNotice')}</p>
    </fieldset>
  )
}

function TextField({
  label,
  value,
  placeholder,
  onChange,
}: {
  readonly label: string
  readonly value: string
  readonly placeholder?: string
  readonly onChange: (value: string) => void
}): ReactNode {
  const id = useId()
  return (
    <label htmlFor={id}>
      {label}
      <Input
        id={id}
        value={value}
        {...(placeholder === undefined ? {} : { placeholder })}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  )
}
