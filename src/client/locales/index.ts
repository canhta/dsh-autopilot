import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { en } from './en.js'
import { type AutopilotLocaleKey, zh } from './zh.js'

export type { AutopilotLocaleKey }
export { en, zh }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    autopilot: AutopilotLocaleKey
  }
}
