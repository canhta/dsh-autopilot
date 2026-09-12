import type { CodeHostBinding } from '../code-host.js'
import type { AutopilotSettings } from '../config.js'
import type { AdmissionState, LegacyAdmissionState } from './state.js'
import { stateSchema } from './state.js'

const migrationSummary =
  'Autopilot upgraded this run from durable state version 6; publication requires operator review.'

export function migrateAdmissionStateV6(
  legacy: LegacyAdmissionState,
  settings: AutopilotSettings,
  codeHostBinding?: CodeHostBinding,
): AdmissionState {
  const runs = legacy.runs.map((stored) => {
    if (!isRecord(stored)) return stored
    const run: Record<string, unknown> = { ...stored, deliveries: [] }
    if ('execution' in run) {
      if (!isRecord(run.execution)) return run
      if (codeHostBinding === undefined) {
        throw new Error('version-6 admission state with allocated runs requires the configured code-host binding')
      }
      run.execution = {
        ...run.execution,
        codeHost: {
          providerId: codeHostBinding.providerId,
          bindingId: codeHostBinding.bindingId,
          repositoryId: codeHostBinding.repositoryId,
          repository: codeHostBinding.repository,
          allowWorkflowChanges: settings.allowWorkflowChanges,
        },
      }
    }
    if (run.state === 'publishing' && isRecord(run.outcome) && run.outcome.kind === 'verified') {
      const evidence = Array.isArray(run.outcome.evidence) ? run.outcome.evidence.slice(0, 99) : []
      return {
        ...run,
        state: 'failed',
        outcome: { kind: 'failed', summary: migrationSummary, evidence: [...evidence, migrationSummary] },
      }
    }
    return run
  })

  return stateSchema.parse({
    ...legacy,
    schemaVersion: 7,
    revision: legacy.revision + 1,
    runs,
    operatorCommands: [],
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
