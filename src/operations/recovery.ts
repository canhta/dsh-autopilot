import type { RecoveryParticipant, RecoveryParticipantFact } from './model.js'

export const REQUIRED_RECOVERY_PARTICIPANTS = ['publication-delivery'] as const

interface ParticipantGeneration {
  readonly participant: RecoveryParticipant
  readonly controller: AbortController
  readonly active: Set<Promise<RecoveryParticipantFact>>
  accepting: boolean
}

export class RecoveryParticipants {
  private readonly generations = new Map<string, ParticipantGeneration>()
  private readonly facts = new Map<string, RecoveryParticipantFact>()

  register(id: string, participant: RecoveryParticipant): () => Promise<void> {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new TypeError(`invalid recovery participant id "${id}"`)
    if (this.generations.has(id)) throw new Error(`recovery participant "${id}" is already registered`)
    const generation: ParticipantGeneration = {
      participant,
      controller: new AbortController(),
      active: new Set(),
      accepting: true,
    }
    this.generations.set(id, generation)
    this.facts.set(id, { pending: 1 })
    return async () => {
      if (this.generations.get(id) !== generation) return
      generation.accepting = false
      generation.controller.abort(new Error(`recovery participant "${id}" was withdrawn`))
      await Promise.allSettled(generation.active)
      if (this.generations.get(id) === generation) {
        this.generations.delete(id)
        this.facts.delete(id)
      }
    }
  }

  async reconcileAll(): Promise<void> {
    for (const id of REQUIRED_RECOVERY_PARTICIPANTS) {
      if (!this.generations.get(id)?.accepting) {
        throw new Error(`required recovery participant "${id}" is unavailable`)
      }
    }
    for (const [id, generation] of [...this.generations]) await this.reconcile(id, generation)
  }

  snapshot(): Readonly<Record<string, RecoveryParticipantFact>> {
    const facts = new Map(this.facts)
    for (const id of REQUIRED_RECOVERY_PARTICIPANTS) {
      if (!this.generations.get(id)?.accepting) {
        facts.set(id, { pending: 1, failure: `required recovery participant "${id}" is unavailable` })
      }
    }
    return Object.fromEntries(facts)
  }

  async dispose(): Promise<void> {
    const generations = [...this.generations.entries()]
    this.generations.clear()
    for (const [id, generation] of generations) {
      generation.accepting = false
      generation.controller.abort(new Error(`recovery participant "${id}" registry was disposed`))
    }
    await Promise.allSettled(generations.flatMap(([, generation]) => [...generation.active]))
    this.facts.clear()
  }

  private async reconcile(id: string, generation: ParticipantGeneration): Promise<void> {
    const operation = Promise.resolve()
      .then(() => generation.participant.reconcile(generation.controller.signal))
      .then(validateRecoveryFact)
    generation.active.add(operation)
    try {
      const fact = await operation
      if (!generation.accepting || generation.controller.signal.aborted) throw generation.controller.signal.reason
      if (this.generations.get(id) !== generation) {
        throw new Error(`recovery participant "${id}" changed during reconciliation`)
      }
      this.facts.set(id, fact)
    } catch (error) {
      if (this.generations.get(id) !== generation || !generation.accepting) throw error
      this.facts.set(id, { pending: 1, failure: boundedError(error) })
    } finally {
      generation.active.delete(operation)
    }
  }
}

function validateRecoveryFact(value: unknown): RecoveryParticipantFact {
  if (typeof value !== 'object' || value === null || !('pending' in value)) {
    throw new TypeError('recovery participant returned an invalid result')
  }
  const fact = value as { pending: unknown; failure?: unknown }
  if (!Number.isSafeInteger(fact.pending) || (fact.pending as number) < 0) {
    throw new TypeError('recovery participant returned an invalid pending count')
  }
  if (
    fact.failure !== undefined &&
    (typeof fact.failure !== 'string' || fact.failure.length === 0 || fact.failure.length > 4096)
  ) {
    throw new TypeError('recovery participant returned an invalid failure')
  }
  const pending = fact.pending as number
  return fact.failure === undefined ? { pending } : { pending, failure: fact.failure as string }
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length <= 4096 ? message : message.slice(0, 4096)
}
