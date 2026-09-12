import type { Context } from '@deepseek-ai/cordis'

const DOMAIN_MODULE = '@deepseek-ai/dsh-storage-domain'
const BACKEND_MODULES = {
  json: { moduleName: '@deepseek-ai/dsh-storage-json', pathField: 'root' },
  sqlite: { moduleName: '@deepseek-ai/dsh-storage-sqlite', pathField: 'path' },
} as const
const AUTOPILOT_DOMAINS = ['autopilot_admission', 'autopilot_maintenance'] as const

interface LoaderEntry {
  readonly disabled: boolean
  readonly options: { readonly name: string; readonly config?: unknown }
  evaluate(expression: string): unknown
}

interface LoaderView {
  entries(): Iterable<LoaderEntry>
}

export interface RuntimeOwnerOptions {
  /** Programmatic host proof for compositions that do not use the DSH Loader. */
  readonly authoritativeStorePath?: string
}

export function authoritativeStorePath(ctx: Context, options: RuntimeOwnerOptions): string {
  if (options.authoritativeStorePath !== undefined) return options.authoritativeStorePath
  const loader = ctx.get('loader') as LoaderView | undefined
  if (loader === undefined) {
    throw new Error(
      'Autopilot cannot prove the authoritative storage medium without a DSH Loader composition or an explicit programmatic host proof',
    )
  }
  return authoritativePathFromEntries([...loader.entries()])
}

export function authoritativePathFromEntries(entries: readonly LoaderEntry[]): string {
  const domainEntry = exactlyOneActive(entries, DOMAIN_MODULE, 'storage-domain')
  const domainConfig = recordConfig(domainEntry, 'storage-domain')
  const defaultBackend = stringValue(domainEntry, domainConfig.backend, 'storage-domain backend')
  const routes = isRecord(domainConfig.routes) ? domainConfig.routes : {}
  const backends = AUTOPILOT_DOMAINS.map((domain) =>
    domain in routes ? stringValue(domainEntry, routes[domain], `${domain} storage route`) : defaultBackend,
  )
  if (new Set(backends).size !== 1) {
    throw new Error('Autopilot admission and maintenance domains must use one authoritative storage backend')
  }
  const backendName = backends[0]
  if (backendName !== 'json' && backendName !== 'sqlite') {
    throw new Error(
      `Autopilot cannot prove medium identity for DSH storage backend "${String(backendName)}"; only official json and sqlite backends expose verifiable Loader configuration`,
    )
  }
  const backend = BACKEND_MODULES[backendName]
  const backendEntry = exactlyOneActive(entries, backend.moduleName, `${backendName} storage backend`)
  const backendConfig = recordConfig(backendEntry, `${backendName} storage backend`)
  const path = stringValue(backendEntry, backendConfig[backend.pathField], `${backendName} storage path`)
  if (path === ':memory:')
    throw new Error('Autopilot requires a durable DSH storage backend with a process-shared identity')
  return path
}

function exactlyOneActive(entries: readonly LoaderEntry[], moduleName: string, subject: string): LoaderEntry {
  const matches = entries.filter((entry) => !entry.disabled && entry.options.name === moduleName)
  if (matches.length !== 1) {
    throw new Error(
      `Autopilot requires exactly one active official ${subject} Loader entry; found ${String(matches.length)}`,
    )
  }
  const entry = matches[0]
  if (entry === undefined) throw new Error(`Autopilot could not resolve the active ${subject} Loader entry`)
  return entry
}

function recordConfig(entry: LoaderEntry, subject: string): Record<string, unknown> {
  if (!isRecord(entry.options.config)) throw new Error(`Autopilot requires explicit ${subject} Loader configuration`)
  return entry.options.config
}

function stringValue(entry: LoaderEntry, raw: unknown, subject: string): string {
  const value = isRecord(raw) && typeof raw.__jsExpr === 'string' ? entry.evaluate(raw.__jsExpr) : raw
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Autopilot requires a non-empty ${subject}`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
