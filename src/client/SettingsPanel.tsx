import type { CredentialInfo, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import type { AutopilotSettings } from '../config.js'
import type { ProviderTestResult } from '../web/contract.js'
import { NotificationSection, RetentionStorageSection } from './SettingsCapabilitySections.js'
import { BudgetSection, ExecutionSection, ScheduleCapacitySection } from './SettingsPolicySections.js'
import { ProviderConnectionSection } from './SettingsProviderSection.js'
import css from './settings.module.css'
import { parseSettingsDraft, type SettingsDraft, toSettingsDraft } from './settings-draft.js'
import type { OperationsClientState } from './state.js'

export interface AutopilotSettingsActions {
  connect(): () => void
  save(ops: readonly SettingsPathOpView[], revision?: number): Promise<void>
  testProvider(providerId: string, signal?: AbortSignal): Promise<ProviderTestResult>
  describeCredentials(refs: readonly string[]): Promise<Record<string, CredentialInfo>>
  setCredential(ref: string, value: string): Promise<void>
  unsetCredential(ref: string): Promise<void>
  openSettingsDocument(signal?: AbortSignal): Promise<void>
}

export interface AutopilotSettingsInjected {
  readonly actions: AutopilotSettingsActions
  readonly hooks: {
    readonly settings: {
      getSnapshot(): SettingsScopeSnapshot<AutopilotSettings>
      subscribe(listener: () => void): () => void
    }
    readonly operations: { getSnapshot(): OperationsClientState; subscribe(listener: () => void): () => void }
  }
}

export type AutopilotSettingsProps = PropsRuntime<'settings.section'> &
  PropsLocale<'autopilot'> &
  InjectFace<AutopilotSettingsInjected>
type Translate = AutopilotSettingsProps['t']

/** Slot adapter: subscribe to DSH stores, then render the data/callback-only Settings view. */
export function AutopilotSettingsPanel({ actions, useSettings, useOperations, t }: AutopilotSettingsProps): ReactNode {
  return (
    <AutopilotSettingsView
      settings={useSettings((value) => value)}
      operations={useOperations((value) => value)}
      actions={actions}
      t={t}
    />
  )
}

export function AutopilotSettingsView({
  settings,
  operations,
  actions,
  t,
}: {
  readonly settings: SettingsScopeSnapshot<AutopilotSettings>
  readonly operations: OperationsClientState
  readonly actions: AutopilotSettingsActions
  readonly t: Translate
}): ReactNode {
  const host = 'data' in operations.operations ? operations.operations.data : undefined
  const [draft, setDraft] = useState<SettingsDraft>()
  const [dirty, setDirty] = useState(false)
  const [feedback, setFeedback] = useState<{
    readonly kind: 'saved' | 'conflict' | 'invalid' | 'open-failed'
    readonly message?: string
  }>()
  const [credentials, setCredentials] = useState<Record<string, CredentialInfo>>()
  const refs = useMemo(
    () =>
      host?.providers.flatMap((provider) =>
        provider.setup.status === 'available' ? provider.setup.credentialRefs.map(({ ref }) => ref) : [],
      ) ?? [],
    [host],
  )

  useEffect(() => actions.connect(), [actions])
  useEffect(() => {
    if (settings.status === 'ready' && settings.value !== undefined && !dirty) setDraft(toSettingsDraft(settings.value))
  }, [settings.status, settings.value, dirty])
  useEffect(() => {
    let current = true
    if (refs.length === 0) setCredentials({})
    else
      void actions.describeCredentials(refs).then(
        (value) => {
          if (current) setCredentials(value)
        },
        () => {
          if (current) setCredentials(undefined)
        },
      )
    return () => {
      current = false
    }
  }, [actions, refs])

  if (settings.status === 'unavailable') return <Message title={t('settingsTitle')} body={t('settingsReadOnly')} />
  if (settings.status === 'loading' || draft === undefined)
    return <Message title={t('settingsTitle')} body={t('settingsLoading')} status />

  const set = <K extends keyof SettingsDraft>(field: K, value: SettingsDraft[K]): void => {
    setDraft((current) => (current === undefined ? current : { ...current, [field]: value }))
    setDirty(true)
    setFeedback(undefined)
  }
  const save = async (): Promise<void> => {
    if (settings.value === undefined) return setFeedback({ kind: 'invalid' })
    const parsed = parseSettingsDraft(draft, settings.value)
    if (parsed === undefined) return setFeedback({ kind: 'invalid' })
    try {
      await actions.save(
        Object.entries(parsed).map(([field, value]) => ({ op: 'set', path: [field], value })),
        settings.revision,
      )
      setDirty(false)
      setFeedback({ kind: 'saved' })
    } catch (error) {
      setFeedback({
        kind: 'conflict',
        ...(error instanceof Error && error.message !== '' ? { message: error.message } : {}),
      })
    }
  }

  return (
    <section className={css.settings} aria-labelledby="autopilot-settings-title">
      <h2 id="autopilot-settings-title">{t('settingsTitle')}</h2>
      <p>{t('settingsIntro')}</p>
      <ProviderConnectionSection
        providers={host?.providers ?? []}
        selectedProvider={draft.trackerProvider}
        codeHostProvider={draft.codeHostProvider}
        allowWorkflowChanges={draft.allowWorkflowChanges}
        credentials={credentials}
        onSelectProvider={(value) => set('trackerProvider', value)}
        onSelectCodeHostProvider={(value) => set('codeHostProvider', value)}
        onAllowWorkflowChanges={(value) => set('allowWorkflowChanges', value)}
        onOpenSettings={async () => {
          try {
            await actions.openSettingsDocument()
          } catch {
            setFeedback({ kind: 'open-failed' })
          }
        }}
        onTestProvider={actions.testProvider}
        onSetCredential={actions.setCredential}
        onUnsetCredential={actions.unsetCredential}
        t={t}
      />
      <ScheduleCapacitySection draft={draft} onChange={set} t={t} />
      <ExecutionSection draft={draft} onChange={set} t={t} />
      <BudgetSection draft={draft} onChange={set} t={t} />
      <NotificationSection
        draft={draft}
        reason={
          host?.integrations.deliveries.status === 'unavailable' ? host.integrations.deliveries.reason : undefined
        }
        onChange={set}
        t={t}
      />
      <RetentionStorageSection
        draft={draft}
        reason={host?.integrations.worktrees.status === 'unavailable' ? host.integrations.worktrees.reason : undefined}
        onChange={set}
        t={t}
      />
      <div className={css.settingsFooter}>
        <Button variant="primary" disabled={!dirty || !settings.writable} onClick={() => void save()}>
          {t('saveSettings')}
        </Button>
        {!settings.writable ? <span>{t('settingsReadOnly')}</span> : null}
        {feedback === undefined ? null : (
          <span role="status" className={feedback.kind === 'saved' ? css.success : css.error}>
            {t(
              feedback.kind === 'saved'
                ? 'settingsSaved'
                : feedback.kind === 'invalid'
                  ? 'invalidSettings'
                  : feedback.kind === 'open-failed'
                    ? 'openSettingsFailed'
                    : 'settingsConflict',
            )}
            {feedback.message === undefined ? '' : ` ${feedback.message}`}
          </span>
        )}
      </div>
    </section>
  )
}

function Message({
  title,
  body,
  status = false,
}: {
  readonly title: string
  readonly body: string
  readonly status?: boolean
}): ReactNode {
  return (
    <section className={css.settings}>
      <h2>{title}</h2>
      <p {...(status ? { role: 'status' } : {})}>{body}</p>
    </section>
  )
}
