import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { CodeHost } from '../code-host.js'
import type { AutopilotSettings } from '../config.js'
import type { Tracker } from '../tracker.js'
import type { STATE_KEY } from './constants.js'
import type { AdmissionState } from './state.js'

export interface AdmissionDependencies {
  readonly codeHost?: CodeHost
  readonly tracker: Tracker
  readonly settings: () => AutopilotSettings
  readonly state: () => AdmissionState
  readonly table: () => KvTable<typeof STATE_KEY, AdmissionState>
}
