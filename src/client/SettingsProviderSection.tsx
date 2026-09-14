import type { CredentialInfo } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import type { OperationsSnapshot, ProviderTestResult } from '../web/contract.js'
import css from './settings.module.css'
import type { AutopilotTranslate } from './settings-draft.js'

type Provider = OperationsSnapshot['providers'][number]

export function ProviderConnectionSection({
  providers,
  selectedProvider,
  codeHostProvider,
  allowWorkflowChanges,
  credentials,
  onSelectProvider,
  onSelectCodeHostProvider,
  onAllowWorkflowChanges,
  onOpenSettings,
  onTestProvider,
  onSetCredential,
  onUnsetCredential,
  t,
}: {
  readonly providers: readonly Provider[]
  readonly selectedProvider: string
  readonly codeHostProvider: string
  readonly allowWorkflowChanges: boolean
  readonly credentials: Record<string, CredentialInfo> | undefined
  readonly onSelectProvider: (providerId: string) => void
  readonly onSelectCodeHostProvider: (providerId: string) => void
  readonly onAllowWorkflowChanges: (allowed: boolean) => void
  readonly onOpenSettings: () => Promise<void>
  readonly onTestProvider: (providerId: string, signal?: AbortSignal) => Promise<ProviderTestResult>
  readonly onSetCredential: (ref: string, value: string) => Promise<void>
  readonly onUnsetCredential: (ref: string) => Promise<void>
  readonly t: AutopilotTranslate
}): ReactNode {
  const [tests, setTests] = useState<Record<string, ProviderTestResult | 'testing'>>({})
  const testRequests = useRef(new Map<string, AbortController>())
  const codeHostProviderInputId = useId()
  const activeProvider = providers.find((provider) => provider.id === selectedProvider)
  useEffect(
    () => () => {
      for (const request of testRequests.current.values()) request.abort()
      testRequests.current.clear()
    },
    [],
  )
  const testProvider = async (provider: Provider): Promise<void> => {
    testRequests.current.get(provider.id)?.abort()
    const request = new AbortController()
    testRequests.current.set(provider.id, request)
    setTests((current) => ({ ...current, [provider.id]: 'testing' }))
    try {
      const result = await onTestProvider(provider.id, request.signal)
      if (request.signal.aborted) return
      setTests((current) => ({ ...current, [provider.id]: result }))
    } catch {
      if (request.signal.aborted) return
      setTests((current) => ({
        ...current,
        [provider.id]: {
          providerId: provider.id,
          checkedAt: new Date().toISOString(),
          status: 'failed',
          reason: t('unavailable'),
        },
      }))
    } finally {
      if (testRequests.current.get(provider.id) === request) testRequests.current.delete(provider.id)
    }
  }

  return (
    <fieldset>
      <legend>{t('providerSection')}</legend>
      <label>
        {t('provider')}
        <select value={selectedProvider} onChange={(event) => onSelectProvider(event.currentTarget.value)}>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.displayName}
            </option>
          ))}
          {providers.some(({ id }) => id === selectedProvider) ? null : (
            <option value={selectedProvider}>{selectedProvider}</option>
          )}
        </select>
      </label>
      <label htmlFor={codeHostProviderInputId}>
        {t('codeHostProviderReference')}
        <Input
          id={codeHostProviderInputId}
          value={codeHostProvider}
          onChange={(event) => onSelectCodeHostProvider(event.currentTarget.value)}
        />
      </label>
      <label className={`${css.checkboxLabel} ${css.fullWidth}`}>
        <input
          type="checkbox"
          checked={allowWorkflowChanges}
          onChange={(event) => onAllowWorkflowChanges(event.currentTarget.checked)}
        />
        {t('allowWorkflowChanges')}
      </label>
      <div className={css.fullWidth}>
        <Button size="sm" variant="outline" onClick={() => void onOpenSettings()}>
          {t('openDshSettings')}
        </Button>
      </div>
      <p className={`${css.notice} ${css.fullWidth}`}>{t('providerSettingsOwnership')}</p>
      {activeProvider === undefined ? (
        <p className={`${css.gap} ${css.fullWidth}`}>{t('configureHint')}</p>
      ) : (
        <ProviderCard
          provider={activeProvider}
          test={tests[activeProvider.id]}
          credentials={credentials}
          onTest={() => testProvider(activeProvider)}
          onSetCredential={onSetCredential}
          onUnsetCredential={onUnsetCredential}
          t={t}
        />
      )}
    </fieldset>
  )
}

function ProviderCard({
  provider,
  test,
  credentials,
  onTest,
  onSetCredential,
  onUnsetCredential,
  t,
}: {
  readonly provider: Provider
  readonly test: ProviderTestResult | 'testing' | undefined
  readonly credentials: Record<string, CredentialInfo> | undefined
  readonly onTest: () => Promise<void>
  readonly onSetCredential: (ref: string, value: string) => Promise<void>
  readonly onUnsetCredential: (ref: string) => Promise<void>
  readonly t: AutopilotTranslate
}): ReactNode {
  return (
    <article className={`${css.providerCard} ${css.fullWidth}`}>
      <div>
        <h3>{provider.displayName}</h3>
        <Tag tone={provider.availability === 'available' ? 'success' : 'danger'}>
          {t(provider.availability === 'available' ? 'providerAvailable' : 'providerUnavailable')}
        </Tag>
      </div>
      <dl>
        <dt>{t('configurationNamespace')}</dt>
        <dd>
          <code>{provider.configurationNamespace || t('unknown')}</code>
        </dd>
      </dl>
      {provider.setup.status === 'unavailable' ? (
        <p className={css.gap}>{provider.setup.reason}</p>
      ) : (
        <>
          <dl>
            <dt>{t('mcpConnection')}</dt>
            <dd>
              <code>{provider.setup.mcpServerName}</code>
            </dd>
            {provider.setup.resources.map((resource) => (
              <div key={resource.label}>
                <dt>{resource.label}</dt>
                <dd>{resource.value || t('notConfigured')}</dd>
              </div>
            ))}
          </dl>
          {provider.setup.lookup.status === 'unavailable' ? (
            <p className={css.gap}>{provider.setup.lookup.reason}</p>
          ) : null}
          {provider.setup.credentialRefs.map((credential) => (
            <CredentialField
              key={credential.ref}
              credential={credential}
              info={credentials?.[credential.ref]}
              onSet={onSetCredential}
              onUnset={onUnsetCredential}
              t={t}
            />
          ))}
        </>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={provider.availability !== 'available' || test === 'testing'}
        onClick={() => void onTest()}
      >
        {t('testConnection')}
      </Button>
      {test === undefined || test === 'testing' ? null : (
        <p role="status" className={test.status === 'ready' ? css.success : css.error}>
          {t(test.status === 'ready' ? 'testReady' : 'testFailed')}
          {test.reason === undefined ? '' : `: ${test.reason}`}
        </p>
      )}
    </article>
  )
}

function CredentialField({
  credential,
  info,
  onSet,
  onUnset,
  t,
}: {
  readonly credential: { label: string; ref: string }
  readonly info: CredentialInfo | undefined
  readonly onSet: (ref: string, value: string) => Promise<void>
  readonly onUnset: (ref: string) => Promise<void>
  readonly t: AutopilotTranslate
}): ReactNode {
  const id = useId()
  const [value, setValue] = useState('')
  const [configured, setConfigured] = useState(info?.configured)
  const [feedback, setFeedback] = useState<'saving' | 'saved' | 'failed'>()
  const write = async (operation: () => Promise<void>, nextConfigured: boolean): Promise<void> => {
    setFeedback('saving')
    try {
      await operation()
      setConfigured(nextConfigured)
      setFeedback('saved')
    } catch {
      setFeedback('failed')
    }
  }
  const status = configured ?? info?.configured
  return (
    <div className={css.credential}>
      <strong>{credential.label}</strong>
      <code>{credential.ref}</code>
      <span>
        {info === undefined ? t('credentialUnavailable') : status ? t('credentialConfigured') : t('credentialMissing')}
      </span>
      <label htmlFor={id}>
        {t('credentialValue')}
        <Input
          id={id}
          type="password"
          autoComplete="new-password"
          value={value}
          disabled={info?.writable !== true || feedback === 'saving'}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      </label>
      <div className={css.credentialActions}>
        <Button
          size="sm"
          disabled={value.length === 0 || info?.writable !== true || feedback === 'saving'}
          onClick={() => void write(() => onSet(credential.ref, value), true).then(() => setValue(''))}
        >
          {t('storeCredential')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={status !== true || info?.writable !== true || feedback === 'saving'}
          onClick={() => void write(() => onUnset(credential.ref), false)}
        >
          {t('removeCredential')}
        </Button>
        {feedback === undefined ? null : (
          <span role="status" className={feedback === 'failed' ? css.error : css.success}>
            {t(
              feedback === 'saving'
                ? 'credentialSaving'
                : feedback === 'saved'
                  ? 'credentialSaved'
                  : 'credentialFailed',
            )}
          </span>
        )}
      </div>
    </div>
  )
}
