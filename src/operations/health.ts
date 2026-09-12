import type { Context } from '@deepseek-ai/cordis'
import type { CleanupInspector } from './cleanup-inspector.js'
import type { OperationsHealth } from './model.js'
import type { RecoveryParticipants } from './recovery.js'
import type { MaintenanceStateStore } from './store.js'

export function projectOperationsHealth(
  ctx: Context,
  store: MaintenanceStateStore,
  recovery: RecoveryParticipants,
  inspector: CleanupInspector,
): OperationsHealth {
  const admission = ctx.admission.snapshot()
  const runIds = admission.runs
    .filter((run) => 'execution' in run && run.execution.recovery !== undefined)
    .map((run) => run.runId)
  const participantFacts = recovery.snapshot()
  const participantFailure =
    store.failure !== undefined || Object.values(participantFacts).some((fact) => fact.failure !== undefined)
  const participantPending = Object.values(participantFacts).some((fact) => fact.pending > 0)
  const pendingCleanup = store.ready() ? store.current().pendingCleanup !== undefined : false
  const recoveryStatus = participantFailure
    ? 'failed'
    : runIds.length > 0 || participantPending || pendingCleanup
      ? 'required'
      : 'complete'
  const mode = admission.scheduler.mode
  return {
    process: { status: 'alive', owner: ctx.runtimeOwner.snapshot() },
    persistence:
      store.failure === undefined
        ? { status: store.ready() ? 'ready' : 'unconfigured' }
        : { status: 'failed', failure: store.failure },
    recovery: {
      status: recoveryStatus,
      runIds,
      pendingCleanup,
      participants: participantFacts,
    },
    integrations: { codeHost: codeHostHealth(ctx, inspector) },
    admission: {
      status: mode !== 'enabled' ? 'paused' : recoveryStatus === 'complete' ? 'permitted' : 'blocked',
      mode,
    },
  }
}

function codeHostHealth(ctx: Context, inspector: CleanupInspector): OperationsHealth['integrations']['codeHost'] {
  if (!ctx.pullRequestDisposition.has(ctx.autopilotConfig.get().codeHostProvider)) return { status: 'unavailable' }
  return inspector.codeHostFailure === undefined
    ? { status: 'available' }
    : { status: 'failed', failure: inspector.codeHostFailure }
}
