import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { type ReactNode, useId } from 'react'
import type { AutopilotTranslate, SettingsDraft } from './settings-draft.js'

type PolicySetting =
  | 'maxQueued'
  | 'maxRunning'
  | 'maxBriefBytes'
  | 'reconcileIntervalSeconds'
  | 'executionMode'
  | 'targetRepository'
  | 'targetBaseBranch'
  | 'managedWorktreeRoot'
  | 'deploymentTokenCap'
  | 'perRunTokenCap'
  | 'runTokenAllowance'
type ChangeSetting = (field: PolicySetting, value: SettingsDraft[PolicySetting]) => void
type SectionProps = { readonly draft: SettingsDraft; readonly onChange: ChangeSetting; readonly t: AutopilotTranslate }

export function ScheduleCapacitySection({ draft, onChange, t }: SectionProps): ReactNode {
  return (
    <fieldset>
      <legend>{t('policySection')}</legend>
      <NumberField
        label={t('maxQueued')}
        value={draft.maxQueued}
        onChange={(v) => onChange('maxQueued', v)}
        min={1}
        max={100}
      />
      <NumberField
        label={t('maxRunning')}
        value={draft.maxRunning}
        onChange={(v) => onChange('maxRunning', v)}
        min={1}
        max={100}
      />
      <NumberField
        label={t('briefLimit')}
        value={draft.maxBriefBytes}
        onChange={(v) => onChange('maxBriefBytes', v)}
        min={1024}
        max={32768}
      />
      <NumberField
        label={t('reconcileSeconds')}
        value={draft.reconcileIntervalSeconds}
        onChange={(v) => onChange('reconcileIntervalSeconds', v)}
        min={5}
      />
    </fieldset>
  )
}

export function ExecutionSection({ draft, onChange, t }: SectionProps): ReactNode {
  return (
    <fieldset>
      <legend>{t('executionSection')}</legend>
      <label>
        {t('executionMode')}
        <select value={draft.executionMode} onChange={(event) => onChange('executionMode', event.currentTarget.value)}>
          <option value="disabled">{t('disabled')}</option>
          <option value="native">{t('native')}</option>
        </select>
      </label>
      <TextField
        label={t('targetRepository')}
        value={draft.targetRepository}
        onChange={(v) => onChange('targetRepository', v)}
      />
      <TextField
        label={t('targetBaseBranch')}
        value={draft.targetBaseBranch}
        onChange={(v) => onChange('targetBaseBranch', v)}
      />
      <TextField
        label={t('managedWorktreeRoot')}
        value={draft.managedWorktreeRoot}
        onChange={(v) => onChange('managedWorktreeRoot', v)}
      />
    </fieldset>
  )
}

export function BudgetSection({ draft, onChange, t }: SectionProps): ReactNode {
  return (
    <fieldset>
      <legend>{t('budgetSection')}</legend>
      <p>{t('budgetNotice')}</p>
      <NumberField
        label={t('deploymentCap')}
        value={draft.deploymentTokenCap}
        onChange={(v) => onChange('deploymentTokenCap', v)}
        min={0}
      />
      <NumberField
        label={t('perRunCap')}
        value={draft.perRunTokenCap}
        onChange={(v) => onChange('perRunTokenCap', v)}
        min={0}
      />
      <NumberField
        label={t('runAllowance')}
        value={draft.runTokenAllowance}
        onChange={(v) => onChange('runTokenAllowance', v)}
        min={0}
      />
    </fieldset>
  )
}

function TextField({
  label,
  value,
  onChange,
}: {
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
}): ReactNode {
  const id = useId()
  return (
    <label htmlFor={id}>
      {label}
      <Input id={id} value={value} onChange={(event) => onChange(event.currentTarget.value)} />
    </label>
  )
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly min: number
  readonly max?: number
}): ReactNode {
  const id = useId()
  return (
    <label htmlFor={id}>
      {label}
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        {...(max === undefined ? {} : { max })}
        step={1}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  )
}
