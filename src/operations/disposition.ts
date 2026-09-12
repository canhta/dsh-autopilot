import { type Context, Service } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { AutopilotRun } from '../admission.js'
import { codeHostProviderId } from '../code-host.js'

const oid = z.string().regex(/^[a-f0-9]{40,64}$/)
const dispositionSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('open'), head: oid }),
  z.object({ state: z.literal('merged'), head: oid, mergedAt: z.iso.datetime({ offset: true }).optional() }),
  z.object({ state: z.literal('closed-unmerged'), head: oid.optional() }),
  z.object({ state: z.literal('unknown'), reason: z.string().min(1).max(4096) }),
])

export type PullRequestDisposition = z.infer<typeof dispositionSchema>

export interface PullRequestDispositionResolver {
  /** Read one run's current PR state without creating, mutating, or authenticating a provider transport. */
  inspect(run: AutopilotRun, signal?: AbortSignal): Promise<PullRequestDisposition>
}

interface ResolverGeneration {
  readonly resolver: PullRequestDispositionResolver
  readonly controller: AbortController
  readonly active: Set<Promise<PullRequestDisposition>>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    pullRequestDisposition: PullRequestDispositionRegistry
  }
}

/** Narrow cleanup-only registry; #8 owns code-host transport, publication, credentials, and delivery. */
export class PullRequestDispositionRegistry extends Service {
  private readonly resolvers = new Map<string, ResolverGeneration>()

  constructor(ctx: Context) {
    super(ctx, 'pullRequestDisposition')
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    yield async () => {
      const generations = [...this.resolvers.values()]
      this.resolvers.clear()
      for (const generation of generations) {
        generation.controller.abort(new Error('PR disposition registry was disposed'))
      }
      await Promise.allSettled(generations.flatMap((generation) => [...generation.active]))
    }
  }

  /**
   * Register one unique resolver. The idempotent async disposer withdraws its generation, cancels active reads and
   * waits for them to settle; invalid/duplicate ids reject before registration.
   */
  register(id: string, resolver: PullRequestDispositionResolver): () => Promise<void> {
    codeHostProviderId(id)
    if (this.resolvers.has(id)) throw new Error(`PR disposition resolver "${id}" is already registered`)
    const generation: ResolverGeneration = { resolver, controller: new AbortController(), active: new Set() }
    this.resolvers.set(id, generation)
    return async () => {
      if (this.resolvers.get(id) !== generation) return
      this.resolvers.delete(id)
      generation.controller.abort(new Error(`PR disposition resolver "${id}" was withdrawn`))
      await Promise.allSettled(generation.active)
    }
  }

  /** Report whether the exact resolver id is live; this detached lookup performs no I/O and never fails. */
  has(id: string): boolean {
    return this.resolvers.has(id)
  }

  /**
   * Read and validate one current disposition through the selected resolver. Missing, provider, and validation failures
   * become fail-closed `unknown` facts. Cancellation and generation withdrawal reject and fence late results.
   */
  async inspect(id: string, run: AutopilotRun, signal?: AbortSignal): Promise<PullRequestDisposition> {
    if (signal?.aborted) throw signal.reason
    const generation = this.resolvers.get(id)
    if (generation === undefined) {
      return { state: 'unknown', reason: id === '' ? 'no code-host provider is configured' : 'provider unavailable' }
    }
    const operationSignal =
      signal === undefined ? generation.controller.signal : AbortSignal.any([signal, generation.controller.signal])
    const operation = Promise.resolve()
      .then(() => generation.resolver.inspect(structuredClone(run), operationSignal))
      .then((value) => dispositionSchema.parse(value))
      .catch((error): PullRequestDisposition => {
        if (operationSignal.aborted) throw operationSignal.reason
        return { state: 'unknown', reason: boundedError(error) }
      })
    generation.active.add(operation)
    try {
      const disposition = await operation
      if (operationSignal.aborted) throw operationSignal.reason
      if (this.resolvers.get(id) !== generation) throw new Error(`PR disposition resolver "${id}" changed during read`)
      return disposition
    } finally {
      generation.active.delete(operation)
    }
  }
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const reason = message.length === 0 ? 'provider inspection failed' : message
  return reason.length <= 4096 ? reason : reason.slice(0, 4096)
}

export default PullRequestDispositionRegistry
