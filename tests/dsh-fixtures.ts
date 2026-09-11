import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Credentials, {
  type CredentialKey,
  type CredentialRecord,
  type CredentialRecordEntry,
  type CredentialRecordInfo,
  type CredentialRef,
} from '@deepseek-ai/dsh-credentials'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Settings, { type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'

export class MemorySettings extends Settings {
  readonly writable = true
  private stored: Record<string, unknown>

  constructor(ctx: Context, options?: { document?: Record<string, unknown> }) {
    super(ctx)
    this.stored = structuredClone(options?.document ?? {})
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.stored))
  }

  protected persist(namespace: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.stored[String(namespace)] = structuredClone(section)
    return Promise.resolve()
  }
}

export class MemoryCredentials extends Credentials {
  readonly values = new Map<string, string>()
  readonly records = new Map<CredentialKey, CredentialRecord>()
  resolveCount = 0

  constructor(ctx: Context, initial: Record<string, string> = {}) {
    super(ctx)
    for (const [reference, value] of Object.entries(initial)) this.values.set(reference, value)
  }

  resolve(reference: CredentialRef): Promise<{ value: string; source: string } | undefined> {
    this.resolveCount += 1
    const value = this.values.get(reference)
    return Promise.resolve(value === undefined || value === '' ? undefined : { value, source: 'memory' })
  }

  describe(reference: CredentialRef): Promise<{ configured: boolean; source?: string; writable: boolean }> {
    const configured = (this.values.get(reference)?.length ?? 0) > 0
    return Promise.resolve({ configured, ...(configured ? { source: 'memory' } : {}), writable: true })
  }

  set(reference: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) return Promise.reject(new TypeError('credential value cannot be empty'))
    this.values.set(reference, value)
    return Promise.resolve()
  }

  unset(reference: CredentialRef): Promise<void> {
    this.values.delete(reference)
    return Promise.resolve()
  }

  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(structuredClone(this.records.get(key)))
  }

  describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const record = this.records.get(key)
    return Promise.resolve({
      configured: record !== undefined,
      ...(record === undefined ? {} : { kind: record.kind }),
      writable: true,
    })
  }

  listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([...this.records].map(([key, record]) => ({ key, kind: record.kind })))
  }

  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(structuredClone(this.records.get(key)))
    if (next !== undefined) this.records.set(key, structuredClone(next))
    return structuredClone(next ?? this.records.get(key))
  }

  deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(key)
    return Promise.resolve()
  }
}

export async function mountHostServices(
  databasePath: string,
  settings: Record<string, unknown> = {},
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemorySettings, { document: settings })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: databasePath })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  return ctx
}

export async function mountExecutionHostServices(
  databasePath: string,
  sessionRoot: string,
  settings: Record<string, unknown> = {},
): Promise<Context> {
  const ctx = await mountHostServices(databasePath, settings)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  return ctx
}

export async function disposeContext(ctx: Context): Promise<void> {
  await ctx.fiber.dispose()
}

export class Deferred<T> {
  readonly promise: Promise<T>
  resolve!: (value: T) => void
  reject!: (reason?: unknown) => void

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
}
