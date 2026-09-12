import { createHash } from 'node:crypto'
import type { NotificationReceipt } from '../notification.js'
import type { TrackerOutboundReceipt } from '../tracker.js'
import { MAX_AUTOMATIC_EXTERNAL_ATTEMPTS, STATE_KEY } from './constants.js'
import { sanitizeDeliveryError } from './deliveries.js'
import type { DeliveryRecord, RunId } from './model.js'
import { boundedExternalRetry } from './policy.js'
import type { AdmissionDependencies } from './ports.js'
import { stateSchema } from './state.js'

export class DeliveryControl {
  constructor(private readonly dependencies: AdmissionDependencies) {}

  async claim(deliveryId: string): Promise<{ runId: RunId; delivery: DeliveryRecord; owner: string }> {
    const owner = crypto.randomUUID()
    let claimed: { runId: RunId; delivery: DeliveryRecord; owner: string } | undefined
    let superseded: Extract<DeliveryRecord, { kind: 'tracker-projection' }> | undefined
    await this.dependencies.table().update(STATE_KEY, (current) => {
      const located = locate(current.runs, deliveryId)
      if (located === undefined) throw new Error(`delivery "${deliveryId}" does not exist`)
      const { run, delivery } = located
      if (delivery.kind === 'tracker-projection' && delivery.status === 'retired') {
        throw new SupersededProjectionError(delivery)
      }
      if (
        delivery.status === 'succeeded' ||
        delivery.status === 'retired' ||
        delivery.status === 'exhausted' ||
        delivery.status === 'permanent-failure'
      ) {
        throw new Error(`delivery "${deliveryId}" is not retryable`)
      }
      if (delivery.status === 'in-flight') throw new Error(`delivery "${deliveryId}" already has an owner`)
      if (delivery.nextRetryAt !== undefined && Date.parse(delivery.nextRetryAt) > Date.now()) {
        throw new Error(`delivery "${deliveryId}" retry is not due`)
      }
      const next = structuredClone(current)
      const nextRun = next.runs[located.runIndex]
      const nextDelivery = nextRun?.deliveries[located.deliveryIndex]
      if (nextRun === undefined || nextDelivery === undefined) throw new Error('delivery disappeared during claim')
      if (nextDelivery.kind === 'tracker-projection') {
        if (isSupersededProjection(current.runs, nextDelivery)) {
          const retired = retireProjection(nextDelivery)
          nextRun.deliveries = nextRun.deliveries.map((candidate, index) =>
            index === located.deliveryIndex ? retired : candidate,
          )
          next.revision += 1
          superseded = retired
          return stateSchema.parse(next)
        }
        if (hasOlderInFlightProjection(current.runs, nextDelivery)) {
          throw new Error(`delivery "${deliveryId}" is waiting for an older issue projection to settle`)
        }
        retireOlderProjections(next.runs, nextDelivery)
      }
      const claimRun = next.runs[located.runIndex]
      const claimDelivery = claimRun?.deliveries[located.deliveryIndex]
      if (claimRun === undefined || claimDelivery === undefined) throw new Error('delivery disappeared before claim')
      const updated: DeliveryRecord = {
        ...claimDelivery,
        revision: claimDelivery.revision + 1,
        status: 'in-flight',
        attempts: claimDelivery.attempts + 1,
        owner,
        nextRetryAt: undefined,
        exhaustedFrom: undefined,
        lastError: undefined,
      }
      claimRun.deliveries = claimRun.deliveries.map((candidate, index) =>
        index === located.deliveryIndex ? updated : candidate,
      )
      next.revision += 1
      stateSchema.parse(next)
      claimed = { runId: run.runId, delivery: updated, owner }
      return next
    })
    if (superseded !== undefined) throw new SupersededProjectionError(superseded)
    if (claimed === undefined) throw new Error(`delivery "${deliveryId}" was not claimed`)
    return structuredClone(claimed)
  }

  assertOwner(runId: RunId, deliveryId: string, owner: string): void {
    const run = this.dependencies.state().runs.find((candidate) => candidate.runId === runId)
    const delivery = run?.deliveries.find((candidate) => candidate.id === deliveryId)
    if (delivery?.status !== 'in-flight' || delivery.owner !== owner) {
      throw new Error(`delivery "${deliveryId}" owner is retired`)
    }
  }

  succeed(
    runId: RunId,
    deliveryId: string,
    owner: string,
    receipt: TrackerOutboundReceipt | NotificationReceipt,
  ): Promise<DeliveryRecord> {
    return this.updateOwned(runId, deliveryId, owner, (delivery) => ({
      ...delivery,
      revision: delivery.revision + 1,
      status: 'succeeded',
      owner: undefined,
      receiptId: receipt.receiptId,
      receivedAt: receipt.receivedAt,
    }))
  }

  fail(
    runId: RunId,
    deliveryId: string,
    owner: string,
    error: unknown,
    status: 'uncertain' | 'retryable-failure' | 'permanent-failure',
    retryAfterMs?: number,
  ): Promise<DeliveryRecord> {
    return this.updateOwned(runId, deliveryId, owner, (delivery) => {
      const exhausted = status !== 'permanent-failure' && delivery.attempts >= MAX_AUTOMATIC_EXTERNAL_ATTEMPTS
      return {
        ...delivery,
        revision: delivery.revision + 1,
        status: exhausted ? 'exhausted' : status,
        owner: undefined,
        lastError: sanitizeDeliveryError(error),
        nextRetryAt:
          !exhausted && status === 'retryable-failure'
            ? new Date(Date.now() + boundedExternalRetry(retryAfterMs, delivery.attempts)).toISOString()
            : undefined,
        exhaustedFrom: exhausted ? status : undefined,
      }
    })
  }

  async retry(deliveryId: string): Promise<DeliveryRecord> {
    let updated: DeliveryRecord | undefined
    await this.dependencies.table().update(STATE_KEY, (current) => {
      const located = locate(current.runs, deliveryId)
      if (located === undefined) throw new Error(`delivery "${deliveryId}" does not exist`)
      if (located.delivery.status === 'succeeded' || located.delivery.status === 'retired') {
        throw new Error(`delivery "${deliveryId}" cannot be retried`)
      }
      if (located.delivery.status === 'in-flight') throw new Error(`delivery "${deliveryId}" already has an owner`)
      const next = structuredClone(current)
      const nextRun = next.runs[located.runIndex]
      if (nextRun === undefined) throw new Error('delivery run disappeared during retry')
      updated = {
        ...located.delivery,
        revision: located.delivery.revision + 1,
        status: 'pending',
        nextRetryAt: undefined,
        exhaustedFrom: undefined,
        lastError: undefined,
      }
      nextRun.deliveries = nextRun.deliveries.map((candidate, index) =>
        index === located.deliveryIndex ? (updated as DeliveryRecord) : candidate,
      )
      next.revision += 1
      return stateSchema.parse(next)
    })
    if (updated === undefined) throw new Error(`delivery "${deliveryId}" retry was not committed`)
    return structuredClone(updated)
  }

  /** Retire one failed mutable projection and atomically persist a revisioned replacement for current lifecycle state. */
  async repairProjection(deliveryId: string): Promise<DeliveryRecord> {
    let replacement: DeliveryRecord | undefined
    await this.dependencies.table().update(STATE_KEY, (current) => {
      const located = locate(current.runs, deliveryId)
      if (located?.delivery.kind !== 'tracker-projection') {
        throw new Error(`delivery "${deliveryId}" is not a tracker projection`)
      }
      if (!['permanent-failure', 'retryable-failure', 'exhausted'].includes(located.delivery.status)) {
        throw new Error(`delivery "${deliveryId}" is not a settled failed projection`)
      }
      const target = located.delivery
      const issueProjections = current.runs.flatMap((run) =>
        run.deliveries.filter(
          (candidate): candidate is Extract<DeliveryRecord, { kind: 'tracker-projection' }> =>
            candidate.kind === 'tracker-projection' && sameProjectionTarget(candidate, target),
        ),
      )
      if (
        issueProjections.some((candidate) => candidate.status === 'in-flight') ||
        issueProjections.some((candidate) => candidate.payload.runRevision > target.payload.runRevision)
      ) {
        throw new Error(`delivery "${deliveryId}" was superseded or still has an in-flight issue projection`)
      }
      const next = structuredClone(current)
      const run = next.runs[located.runIndex]
      const obsolete = run?.deliveries[located.deliveryIndex]
      if (run === undefined || obsolete?.kind !== 'tracker-projection') {
        throw new Error('tracker projection disappeared during repair')
      }
      const desiredState = projectionStateFor(run.state)
      const trackerDeliveryId = `tracker:${createHash('sha256')
        .update(`${obsolete.payload.deliveryId}\0repair\0${String(current.revision + 1)}`)
        .digest('hex')
        .slice(0, 40)}`
      replacement = {
        id: `delivery:${createHash('sha256').update(trackerDeliveryId).digest('hex').slice(0, 40)}`,
        eventId: obsolete.eventId,
        revision: 1,
        status: 'pending',
        attempts: 0,
        kind: 'tracker-projection',
        providerId: obsolete.providerId,
        payload: {
          ...obsolete.payload,
          deliveryId: trackerDeliveryId,
          runRevision: current.revision + 1,
          desiredState,
        },
      }
      run.deliveries = run.deliveries.map((candidate, index) =>
        index === located.deliveryIndex
          ? {
              ...obsolete,
              revision: obsolete.revision + 1,
              status: 'retired',
              nextRetryAt: undefined,
              exhaustedFrom: undefined,
            }
          : candidate,
      )
      run.deliveries.push(replacement)
      next.revision += 1
      return stateSchema.parse(next)
    })
    if (replacement === undefined) throw new Error(`delivery "${deliveryId}" repair was not committed`)
    return structuredClone(replacement)
  }

  private async updateOwned(
    runId: RunId,
    deliveryId: string,
    owner: string,
    mutate: (delivery: DeliveryRecord) => DeliveryRecord,
  ): Promise<DeliveryRecord> {
    let updated: DeliveryRecord | undefined
    await this.dependencies.table().update(STATE_KEY, (current) => {
      const next = structuredClone(current)
      const run = next.runs.find((candidate) => candidate.runId === runId)
      const index = run?.deliveries.findIndex((candidate) => candidate.id === deliveryId) ?? -1
      const delivery = run?.deliveries[index]
      if (run === undefined || delivery?.status !== 'in-flight' || delivery.owner !== owner) {
        throw new Error(`delivery "${deliveryId}" owner is retired`)
      }
      updated = mutate(delivery)
      run.deliveries = run.deliveries.map((candidate, candidateIndex) =>
        candidateIndex === index ? (updated as DeliveryRecord) : candidate,
      )
      next.revision += 1
      return stateSchema.parse(next)
    })
    if (updated === undefined) throw new Error(`delivery "${deliveryId}" update was not committed`)
    return structuredClone(updated)
  }
}

export class SupersededProjectionError extends Error {
  constructor(readonly delivery: Extract<DeliveryRecord, { kind: 'tracker-projection' }>) {
    super(`delivery "${delivery.id}" was superseded before dispatch`)
    this.name = 'SupersededProjectionError'
  }
}

function isSupersededProjection(
  runs: readonly import('./model.js').AutopilotRun[],
  target: Extract<DeliveryRecord, { kind: 'tracker-projection' }>,
): boolean {
  return runs.some((run) =>
    run.deliveries.some(
      (candidate) =>
        candidate.kind === 'tracker-projection' &&
        candidate.id !== target.id &&
        sameProjectionTarget(candidate, target) &&
        candidate.payload.runRevision > target.payload.runRevision,
    ),
  )
}

function hasOlderInFlightProjection(
  runs: readonly import('./model.js').AutopilotRun[],
  target: Extract<DeliveryRecord, { kind: 'tracker-projection' }>,
): boolean {
  return runs.some((run) =>
    run.deliveries.some(
      (candidate) =>
        candidate.kind === 'tracker-projection' &&
        candidate.id !== target.id &&
        sameProjectionTarget(candidate, target) &&
        candidate.payload.runRevision < target.payload.runRevision &&
        candidate.status === 'in-flight',
    ),
  )
}

function retireOlderProjections(
  runs: import('./model.js').AutopilotRun[],
  target: Extract<DeliveryRecord, { kind: 'tracker-projection' }>,
): void {
  for (const [index, run] of runs.entries()) {
    runs[index] = {
      ...run,
      deliveries: run.deliveries.map((candidate) =>
        candidate.kind === 'tracker-projection' &&
        sameProjectionTarget(candidate, target) &&
        candidate.payload.runRevision < target.payload.runRevision &&
        !['succeeded', 'retired'].includes(candidate.status)
          ? retireProjection(candidate)
          : candidate,
      ),
    }
  }
}

function retireProjection(
  projection: Extract<DeliveryRecord, { kind: 'tracker-projection' }>,
): Extract<DeliveryRecord, { kind: 'tracker-projection' }> {
  const {
    exhaustedFrom: _exhaustedFrom,
    lastError: _lastError,
    nextRetryAt: _nextRetryAt,
    owner: _owner,
    ...retained
  } = projection
  return { ...retained, revision: projection.revision + 1, status: 'retired' }
}

function sameProjectionTarget(
  left: Extract<DeliveryRecord, { kind: 'tracker-projection' }>,
  right: Extract<DeliveryRecord, { kind: 'tracker-projection' }>,
): boolean {
  return (
    left.providerId === right.providerId &&
    left.payload.bindingId === right.payload.bindingId &&
    left.payload.issueId === right.payload.issueId
  )
}

function projectionStateFor(state: import('./model.js').AutopilotRun['state']) {
  switch (state) {
    case 'queued':
      return 'queued' as const
    case 'implementing':
    case 'pausing':
    case 'publishing':
      return 'implementing' as const
    case 'paused':
      return 'paused' as const
    case 'blocked':
      return 'blocked' as const
    case 'failed':
      return 'failed' as const
    case 'completed':
      return 'completed' as const
    case 'cancelled':
      throw new Error('cancelled runs have no default tracker projection')
  }
}

function locate(runs: readonly import('./model.js').AutopilotRun[], deliveryId: string) {
  for (const [runIndex, run] of runs.entries()) {
    const deliveryIndex = run.deliveries.findIndex((candidate) => candidate.id === deliveryId)
    const delivery = run.deliveries[deliveryIndex]
    if (delivery !== undefined) return { run, delivery, runIndex, deliveryIndex }
  }
  return undefined
}
