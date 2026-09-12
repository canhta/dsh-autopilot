export interface ProviderGeneration<P> {
  readonly provider: P
  readonly controller: AbortController
  readonly active: Set<Promise<unknown>>
  accepting: boolean
}

/** Shared lifecycle core for provider registries; protocol validation and error normalization stay with each seam. */
export class GenerationRegistry<K, P> {
  private readonly generations = new Map<K, ProviderGeneration<P>>()

  constructor(
    private readonly onAvailable?: (key: K) => void,
    private readonly onUnavailable?: (key: K) => void,
  ) {}

  has(key: K): boolean {
    return this.generations.has(key)
  }

  values(): IterableIterator<ProviderGeneration<P>> {
    return this.generations.values()
  }

  register(key: K, provider: P): () => Promise<void> {
    if (this.generations.has(key)) throw new Error(`provider "${String(key)}" is already registered`)
    const generation: ProviderGeneration<P> = {
      provider,
      controller: new AbortController(),
      active: new Set(),
      accepting: true,
    }
    this.generations.set(key, generation)
    this.onAvailable?.(key)
    return async () => {
      if (this.generations.get(key) !== generation) return
      generation.accepting = false
      generation.controller.abort(new Error(`provider "${String(key)}" was withdrawn`))
      await Promise.allSettled(generation.active)
      if (this.generations.get(key) === generation) {
        this.generations.delete(key)
        this.onUnavailable?.(key)
      }
    }
  }

  require(key: K, unavailable: () => Error): ProviderGeneration<P> {
    const generation = this.generations.get(key)
    if (generation === undefined || !generation.accepting) throw unavailable()
    return generation
  }

  async retain<T>(generation: ProviderGeneration<P>, operation: () => Promise<T>): Promise<T> {
    let active: Promise<T>
    try {
      active = Promise.resolve(operation())
    } catch (error) {
      active = Promise.reject(error)
    }
    generation.active.add(active)
    try {
      return await active
    } finally {
      generation.active.delete(active)
    }
  }

  assertCurrent(generation: ProviderGeneration<P>, unavailable: () => Error): void {
    if (!generation.accepting) throw unavailable()
  }

  signal(generation: ProviderGeneration<P>, callerSignal?: AbortSignal): AbortSignal {
    callerSignal?.throwIfAborted()
    return callerSignal === undefined
      ? generation.controller.signal
      : AbortSignal.any([generation.controller.signal, callerSignal])
  }
}
