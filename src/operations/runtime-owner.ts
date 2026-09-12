import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, rmdir, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { type Context, Service } from '@deepseek-ai/cordis'
import { authoritativeStorePath, type RuntimeOwnerOptions } from './storage-composition.js'

const OWNER_FILE = 'owner.json'

interface OwnerRecord {
  readonly version: 1
  readonly pid: number
  readonly nonce: string
  readonly acquiredAt: string
  readonly bootId?: string
  readonly processStart?: string
}

export class RuntimeStoreOwnedError extends Error {
  constructor(readonly owner: Pick<OwnerRecord, 'pid' | 'acquiredAt'> | undefined) {
    super(
      owner === undefined
        ? 'the Autopilot runtime store has an incomplete owner fence'
        : `the Autopilot runtime store is already owned by process ${String(owner.pid)} since ${owner.acquiredAt}`,
    )
    this.name = 'RuntimeStoreOwnedError'
  }
}

export class RuntimeStoreConfigurationError extends Error {
  constructor(configured: string, authoritative: string) {
    super(`runtimeStorePath "${configured}" does not match the authoritative DSH storage backend "${authoritative}"`)
    this.name = 'RuntimeStoreConfigurationError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    runtimeOwner: RuntimeOwner
  }
}

/** Hold the one-VPS fence for the authoritative DSH storage medium before Autopilot opens durable state. */
export class RuntimeOwner extends Service {
  static readonly inject = ['autopilotConfig']

  private owned: { storePath: string; lockPath: string; record: OwnerRecord } | undefined
  private holders = 0
  private closing = false
  private waitForHolders: (() => void) | undefined

  constructor(
    ctx: Context,
    private readonly options: RuntimeOwnerOptions = {},
  ) {
    super(ctx, 'runtimeOwner')
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    await this.ensureOwned()
    yield async () => {
      this.closing = true
      if (this.holders > 0) {
        await new Promise<void>((resolve) => {
          this.waitForHolders = resolve
        })
      }
      await this.release()
    }
  }

  /**
   * Acquire the authoritative DSH storage-medium fence, or prove this service already owns that exact canonical
   * medium. An optional runtimeStorePath is only a configuration assertion. Unprovable or changed media,
   * unsafe/incomplete targets and a live owner reject; stale local-process ownership is reclaimed atomically.
   */
  async ensureOwned(): Promise<string> {
    if (this.closing) throw new Error('the runtime-store owner is shutting down')
    const storePath = await canonicalPath(authoritativeStorePath(this.ctx, this.options))
    const configured = this.ctx.autopilotConfig.get().runtimeStorePath
    if (configured !== '') {
      const configuredPath = await canonicalPath(configured)
      if (configuredPath !== storePath) throw new RuntimeStoreConfigurationError(configuredPath, storePath)
    }
    if (this.owned?.storePath === storePath) return storePath
    if (this.owned !== undefined) {
      throw new Error('the authoritative DSH storage medium cannot change while this Host owns another medium')
    }
    const lockPath = `${storePath}.autopilot-owner`
    const record = await acquire(lockPath)
    this.owned = { storePath, lockPath, record }
    return storePath
  }

  /**
   * Keep the owner fence alive through a dependent service's complete asynchronous shutdown. Rejects during owner
   * shutdown; the returned idempotent release callback performs no I/O.
   */
  hold(): () => void {
    if (this.closing) throw new Error('the runtime-store owner is shutting down')
    this.holders += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.holders -= 1
      if (this.holders === 0) this.waitForHolders?.()
    }
  }

  /** Return detached owner/fence facts without touching the filesystem; available until this service is disposed. */
  snapshot(): { status: 'held'; storePath: string; acquiredAt: string } | { status: 'unconfigured' } {
    return this.owned === undefined
      ? { status: 'unconfigured' }
      : { status: 'held', storePath: this.owned.storePath, acquiredAt: this.owned.record.acquiredAt }
  }

  private async release(): Promise<void> {
    const owned = this.owned
    if (owned === undefined) return
    this.owned = undefined
    let current: OwnerRecord | undefined
    try {
      current = await readOwner(owned.lockPath)
    } catch {
      return
    }
    if (current?.nonce !== owned.record.nonce) return
    const releasePath = `${owned.lockPath}.release-${owned.record.nonce}`
    try {
      await rename(owned.lockPath, releasePath)
      await removeLockDirectory(releasePath)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
}

async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path)
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 })
  try {
    return await realpath(absolute)
  } catch (error) {
    if (!isMissing(error)) throw error
    return join(await realpath(dirname(absolute)), basename(absolute))
  }
}

async function acquire(lockPath: string): Promise<OwnerRecord> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  for (;;) {
    const record = await currentOwnerRecord()
    try {
      await mkdir(lockPath, { mode: 0o700 })
      const handle = await open(`${lockPath}/${OWNER_FILE}`, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      return record
    } catch (error) {
      if (!isAlreadyExists(error)) {
        try {
          await removeLockDirectory(lockPath)
        } catch {
          // Preserve the acquisition error; a partial fence fails closed on the next attempt.
        }
        throw error
      }
    }

    let metadata: Awaited<ReturnType<typeof lstat>>
    try {
      metadata = await lstat(lockPath)
    } catch (error) {
      if (isMissing(error)) continue
      throw error
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new RuntimeStoreOwnedError(undefined)
    const existing = await readOwner(lockPath)
    if (
      (existing === undefined && !(await incompleteFenceIsStale(lockPath))) ||
      (existing !== undefined && (await ownerIsLive(existing)))
    ) {
      throw new RuntimeStoreOwnedError(existing)
    }
    const stalePath = `${lockPath}.stale-${randomUUID()}`
    try {
      await rename(lockPath, stalePath)
    } catch (error) {
      if (isMissing(error)) continue
      throw error
    }
    await removeLockDirectory(stalePath)
  }
}

async function currentOwnerRecord(): Promise<OwnerRecord> {
  const [bootId, processStart] = await Promise.all([linuxBootId(), linuxProcessStart(process.pid)])
  return {
    version: 1,
    pid: process.pid,
    nonce: randomUUID(),
    acquiredAt: new Date().toISOString(),
    ...(bootId === undefined ? {} : { bootId }),
    ...(processStart === undefined ? {} : { processStart }),
  }
}

async function readOwner(lockPath: string): Promise<OwnerRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(`${lockPath}/${OWNER_FILE}`, 'utf8')) as Partial<OwnerRecord>
    if (
      parsed.version !== 1 ||
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid ?? 0) <= 0 ||
      typeof parsed.nonce !== 'string' ||
      parsed.nonce.length === 0 ||
      typeof parsed.acquiredAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.acquiredAt))
    ) {
      return undefined
    }
    return parsed as OwnerRecord
  } catch (error) {
    if (!isMissing(error)) return undefined
    return undefined
  }
}

async function incompleteFenceIsStale(lockPath: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs >= 5_000
  } catch {
    return false
  }
}

async function ownerIsLive(owner: OwnerRecord): Promise<boolean> {
  const bootId = await linuxBootId()
  if (owner.bootId !== undefined && bootId !== undefined && owner.bootId !== bootId) return false
  const processStart = await linuxProcessStart(owner.pid)
  if (owner.processStart !== undefined && processStart !== undefined) return owner.processStart === processStart
  try {
    process.kill(owner.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function linuxBootId(): Promise<string | undefined> {
  try {
    return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  } catch {
    return undefined
  }
}

async function linuxProcessStart(pid: number): Promise<string | undefined> {
  try {
    const value = await readFile(`/proc/${String(pid)}/stat`, 'utf8')
    const close = value.lastIndexOf(')')
    return value.slice(close + 2).split(' ')[19]
  } catch {
    return undefined
  }
}

async function removeLockDirectory(path: string): Promise<void> {
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('refusing to remove a runtime-owner fence that is not a directory')
  }
  try {
    await unlink(`${path}/${OWNER_FILE}`)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  await rmdir(path)
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST'
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export default RuntimeOwner
