import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { STATE_KEY } from './constants.js'
import type { AdmissionSnapshot } from './model.js'
import { compareSnapshotRuns } from './policy.js'
import { type AdmissionState, type StoredAdmissionState, storedAdmissionStateSchema } from './state.js'

export const admissionDomainSpec = defineDomain({
  name: 'autopilot_admission',
  // State v7 is an in-place record migration; the DSH domain layout remains compatible with its v6 stamp.
  version: 6,
  tables: {
    state: domainTable<typeof STATE_KEY, StoredAdmissionState>(storedAdmissionStateSchema),
  },
})

export function initialState(): AdmissionState {
  return {
    schemaVersion: 7,
    revision: 0,
    nextSequence: 1,
    runs: [],
    acceptedIngress: [],
    operatorCommands: [],
    scheduler: { mode: 'enabled', changedAt: new Date().toISOString() },
    budget: { reservedTokens: 0, settledTokens: 0, usageUncertain: false },
  }
}

export function snapshotOf(state: AdmissionState): AdmissionSnapshot {
  return {
    revision: state.revision,
    runs: structuredClone(state.runs).sort(compareSnapshotRuns),
    acceptedIngress: [...state.acceptedIngress],
    scheduler: structuredClone(state.scheduler),
    budget: structuredClone(state.budget),
  }
}
