import { createHash } from 'node:crypto'
import type { RefinementCtx } from 'zod'
import type { AutopilotRun, CancelledPausedActiveRun, SchedulerMode } from './model.js'
import { isPausedActiveRun, runId, runIdentityFromRun } from './policy.js'

export interface StateIntegrityInput {
  readonly nextSequence: number
  readonly runs: readonly AutopilotRun[]
  readonly acceptedIngress: readonly string[]
  readonly operatorCommands: readonly { readonly requestId: string }[]
  readonly scheduler: { readonly mode: SchedulerMode }
  readonly budget: {
    readonly reservedTokens: number
    readonly settledTokens: number
    readonly usageUncertain: boolean
  }
}

export function validateStateIntegrity(value: StateIntegrityInput, context: RefinementCtx): void {
  const identities = value.runs.map(runIdentityFromRun)
  const sequences = value.runs.map((run) => run.queueSequence)
  const issue = (message: string): void => context.addIssue({ code: 'custom', message })
  if (new Set(value.runs.map((run) => run.runId)).size !== value.runs.length) issue('run ids must be unique')
  if (new Set(sequences).size !== sequences.length) issue('queue sequences must be unique')
  if (new Set(value.acceptedIngress).size !== value.acceptedIngress.length) issue('accepted ingress ids must be unique')
  if (new Set(value.operatorCommands.map(({ requestId }) => requestId)).size !== value.operatorCommands.length) {
    issue('operator command request ids must be unique')
  }
  if (value.runs.some((run, index) => run.runId !== runId(identities[index] ?? ''))) {
    issue('run ids must match their durable identities')
  }
  if (value.runs.some((run) => createHash('sha256').update(run.brief.content).digest('hex') !== run.brief.digest)) {
    issue('Brief digests must match retained content')
  }
  if (value.scheduler.mode === 'disabled' && value.runs.some((run) => run.state === 'implementing')) {
    issue('disabled scheduler cannot retain an implementing run')
  }
  if (sequences.length > 0 && value.nextSequence <= Math.max(...sequences)) {
    issue('next queue sequence must follow every retained run')
  }
  const runReservations = value.runs.reduce(
    (total, run) => total + ('budget' in run ? run.budget.reservedTokens : 0),
    0,
  )
  if (runReservations !== value.budget.reservedTokens) {
    issue('deployment reservation must equal active run reservations')
  }
  const runSettlements = value.runs.reduce((total, run) => total + ('budget' in run ? run.budget.settledTokens : 0), 0)
  if (runSettlements !== value.budget.settledTokens) issue('deployment settlement must equal retained run settlements')
  const uncertain = value.runs.some((run) => 'budget' in run && run.budget.usageUncertain)
  if (uncertain !== value.budget.usageUncertain)
    issue('deployment usage uncertainty must match retained run uncertainty')

  for (const run of value.runs) {
    if ('budget' in run && run.budget.usageUncertain !== (run.budget.usageUncertaintyReason !== undefined)) {
      issue('run usage uncertainty must retain exactly one actionable reason')
    }
    const activePause =
      run.state === 'pausing' || isPausedActiveRun(run)
        ? run.pause
        : isCancelledPausedActiveRun(run)
          ? run.pause
          : undefined
    if (activePause !== undefined && activePause.operatorHold !== (activePause.reason === 'operator')) {
      issue('active operator pause reason and hold must agree')
    }
    if ((run.state === 'implementing' || run.state === 'pausing') && run.budget.usageUncertain) {
      issue('active runs cannot carry uncertain usage')
    }
    if ('budget' in run && run.budget.settledTokens + run.budget.reservedTokens > run.budget.capTokens) {
      issue('run settled usage and reservation must stay within its retained cap')
    }
    if ('budget' in run && run.budget.reservedTokens > run.budget.allowanceTokens) {
      issue('run reservation must stay within its immutable attempt allowance')
    }
    if (run.state === 'publishing' && run.outcome.kind !== 'verified')
      issue('publishing runs require a verified outcome')
    if ((run.state === 'publishing' || run.state === 'completed') && run.publication === undefined) {
      issue('publishing and completed runs require a publication intent')
    }
    if (
      run.state === 'completed' &&
      (run.outcome.kind !== 'verified' ||
        run.publication?.status !== 'succeeded' ||
        run.publication.receipt === undefined)
    ) {
      issue('completed runs require verified work and a successful publication receipt')
    }
    const publication = 'publication' in run ? run.publication : undefined
    if (publication?.status === 'succeeded' && publication.receipt === undefined) {
      issue('successful publication requires a receipt')
    }
    if ((publication?.status === 'in-flight') !== (publication?.owner !== undefined)) {
      issue('in-flight publication must have exactly one owner')
    }
    if ((publication?.status === 'exhausted') !== (publication?.exhaustedFrom !== undefined)) {
      issue('exhausted publication must retain exactly one failure classification')
    }
    const deliveryIds = run.deliveries.map((delivery) => delivery.id)
    if (new Set(deliveryIds).size !== deliveryIds.length) issue('delivery ids must be unique per run')
    for (const delivery of run.deliveries) {
      if ((delivery.status === 'in-flight') !== (delivery.owner !== undefined)) {
        issue('in-flight delivery must have exactly one owner')
      }
      if (delivery.status === 'succeeded' && (delivery.receiptId === undefined || delivery.receivedAt === undefined)) {
        issue('successful delivery requires a receipt')
      }
      if ((delivery.status === 'exhausted') !== (delivery.exhaustedFrom !== undefined)) {
        issue('exhausted delivery must retain exactly one failure classification')
      }
    }
    if ((run.state === 'blocked' || run.state === 'failed') && run.outcome.kind !== run.state) {
      issue('terminal lifecycle state must match its structured outcome')
    }
  }
}

function isCancelledPausedActiveRun(run: AutopilotRun): run is CancelledPausedActiveRun {
  return run.state === 'cancelled' && run.cancellation.from === 'paused-active'
}
