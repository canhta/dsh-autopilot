import type { RunId } from './model.js'

interface RunFenceEntry {
  generation: number
  tail: Promise<void>
}

/** Serialize lifecycle and maintenance work for one run and fence stale observations with a process-local generation. */
export class RunOperationFence {
  private readonly entries = new Map<RunId, RunFenceEntry>()

  generation(runId: RunId): number {
    return this.entry(runId).generation
  }

  exclusive<T>(runId: RunId, operation: () => Promise<T>): Promise<T> {
    return this.lock(runId, operation, false)
  }

  mutate<T>(runId: RunId, operation: () => Promise<T>): Promise<T> {
    return this.lock(runId, operation, true)
  }

  async mutateMany<T>(runIds: readonly RunId[], operation: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(runIds)].sort()
    const lockAt = async (index: number): Promise<T> => {
      const runId = ordered[index]
      return runId === undefined ? await operation() : await this.lock(runId, () => lockAt(index + 1), true)
    }
    return await lockAt(0)
  }

  private async lock<T>(runId: RunId, operation: () => Promise<T>, mutate: boolean): Promise<T> {
    const entry = this.entry(runId)
    const previous = entry.tail
    let release: (() => void) | undefined
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    entry.tail = previous.catch(() => undefined).then(() => current)
    await previous.catch(() => undefined)
    try {
      const result = await operation()
      if (mutate) entry.generation += 1
      return result
    } finally {
      release?.()
    }
  }

  private entry(runId: RunId): RunFenceEntry {
    let entry = this.entries.get(runId)
    if (entry === undefined) {
      entry = { generation: 0, tail: Promise.resolve() }
      this.entries.set(runId, entry)
    }
    return entry
  }
}
