import type { PausedActiveRun, TerminalRun } from '../admission.js'

export const FIXTURE_PROVIDER = 'dsh-autopilot-fixture'
export const FIXTURE_MODEL = 'controlled'

export type DispatchResult = TerminalRun | PausedActiveRun
