import { type TrackerIngressRequest, trackerProviderId } from '../tracker.js'
import { readEveryCandidate } from './candidates.js'
import { MAX_INGRESS_RECEIPTS, STATE_KEY } from './constants.js'
import {
  type AdmissionDecision,
  AdmissionIngressError,
  type QueuedRun,
  type ReconcileRequest,
  type ReconcileResult,
} from './model.js'
import {
  assertStateSize,
  type EligibleIssue,
  evaluateIssue,
  runId,
  runIdentity,
  runIdentityFromRun,
  validateRequest,
} from './policy.js'
import type { AdmissionDependencies } from './ports.js'
import { snapshotOf, stateSchema } from './state.js'

/** Read the selected provider and atomically admit every currently eligible issue. */
export async function reconcile(
  dependencies: AdmissionDependencies,
  request: ReconcileRequest,
): Promise<ReconcileResult> {
  validateRequest(request)
  request.signal?.throwIfAborted()
  const settings = dependencies.settings()
  const providerId = trackerProviderId(settings.trackerProvider)
  if (request.deliveryId !== undefined && !request.deliveryId.startsWith(`${providerId}:`)) {
    throw new TypeError(`delivery id must be qualified by tracker provider "${providerId}"`)
  }
  const beforeRead = dependencies.state()
  if (beforeRead.scheduler.mode !== 'enabled') {
    return { ...snapshotOf(beforeRead), decisions: [] }
  }
  if (request.deliveryId !== undefined && beforeRead.acceptedIngress.includes(request.deliveryId)) {
    return { ...snapshotOf(beforeRead), decisions: [] }
  }

  return dependencies.tracker.withProvider(providerId, async (reader) => {
    const candidates = await readEveryCandidate(reader, providerId, request.signal)
    request.signal?.throwIfAborted()
    const evaluated = candidates.map((issue) => evaluateIssue(issue, settings.maxBriefBytes))
    const eligible = evaluated
      .map((evaluation, index) => ({ evaluation, index }))
      .filter((entry): entry is { evaluation: EligibleIssue; index: number } => !('reason' in entry.evaluation))
      .sort(
        (left, right) =>
          left.evaluation.issue.priorityRank - right.evaluation.issue.priorityRank ||
          runIdentity(providerId, left.evaluation.issue).localeCompare(runIdentity(providerId, right.evaluation.issue)),
      )
    let decisions: AdmissionDecision[] = []
    const committed = await dependencies.table().update(STATE_KEY, (current) => {
      request.signal?.throwIfAborted()
      if (current.scheduler.mode !== 'enabled') {
        decisions = []
        return current
      }
      if (request.deliveryId !== undefined && current.acceptedIngress.includes(request.deliveryId)) {
        decisions = []
        return current
      }
      const next = structuredClone(current)
      const indexedDecisions: Array<AdmissionDecision | undefined> = evaluated.map((evaluation) => {
        if ('reason' in evaluation) {
          return { displayKey: evaluation.displayKey, outcome: 'rejected', reason: evaluation.reason }
        }
        return undefined
      })
      for (const { evaluation, index } of eligible) {
        const issue = evaluation.issue
        const identity = runIdentity(providerId, issue)
        if (next.runs.some((run) => runIdentityFromRun(run) === identity)) {
          indexedDecisions[index] = { displayKey: issue.displayKey, outcome: 'duplicate' }
          continue
        }
        if (next.runs.length >= settings.maxQueued) {
          indexedDecisions[index] = { displayKey: issue.displayKey, outcome: 'deferred', reason: 'queue-capacity' }
          continue
        }

        const run: QueuedRun = {
          runId: runId(identity),
          providerId,
          bindingId: issue.bindingId,
          issueId: issue.issueId,
          displayKey: issue.displayKey,
          summary: issue.summary,
          priorityRank: issue.priorityRank,
          readinessGeneration: issue.readiness.generation,
          brief: evaluation.brief,
          state: 'queued',
          queueClass: 'new',
          queuedAt: new Date().toISOString(),
          queueSequence: next.nextSequence,
        }
        next.runs.push(run)
        next.nextSequence += 1
        indexedDecisions[index] = { displayKey: issue.displayKey, outcome: 'queued' }
      }
      decisions = indexedDecisions.filter((decision) => decision !== undefined)

      const capacityDeferred = decisions.some((decision) => decision.outcome === 'deferred')
      if (request.deliveryId !== undefined && !capacityDeferred) {
        next.acceptedIngress.push(request.deliveryId)
        if (next.acceptedIngress.length > MAX_INGRESS_RECEIPTS) next.acceptedIngress.shift()
      }
      next.revision += 1
      const parsed = stateSchema.parse(next)
      assertStateSize(parsed)
      return parsed
    })

    const result = { ...snapshotOf(committed), decisions }
    if (request.deliveryId !== undefined && decisions.some((decision) => decision.outcome === 'deferred')) {
      throw new AdmissionIngressError('queue-capacity')
    }
    return result
  })
}

/** Authenticate ingress and retain its provider generation through the durable commit. */
export async function reconcileIngress(
  dependencies: AdmissionDependencies,
  request: TrackerIngressRequest,
  signal?: AbortSignal,
): Promise<ReconcileResult> {
  signal?.throwIfAborted()
  const providerId = trackerProviderId(dependencies.settings().trackerProvider)
  return dependencies.tracker.withProvider(providerId, async (reader) => {
    const delivery = await reader.verifyIngress(request, signal)
    signal?.throwIfAborted()
    const result = await reconcile(dependencies, {
      source: 'webhook',
      deliveryId: delivery.deliveryId,
      ...(signal === undefined ? {} : { signal }),
    })
    if (!result.acceptedIngress.includes(delivery.deliveryId)) {
      throw new AdmissionIngressError('not-accepting')
    }
    return result
  })
}
