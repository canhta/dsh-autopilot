import { Context } from '@deepseek-ai/cordis'
import Credentials, { type CredentialRef } from '@deepseek-ai/dsh-credentials'
import Settings, { type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'

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
