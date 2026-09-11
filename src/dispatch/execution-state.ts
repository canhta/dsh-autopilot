import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { AdmissionSnapshot, AutopilotRun, GitExecutionSnapshot, PausedActiveRun, RunId } from '../admission.js'

export interface ActiveExecution {
  handle?: AgentHandle
  pauseRequested: boolean
  readonly completion: Promise<void>
  complete(): void
}

export function activeExecution(): ActiveExecution {
  let complete: (() => void) | undefined
  const completion = new Promise<void>((resolve) => {
    complete = resolve
  })
  return {
    pauseRequested: false,
    completion,
    complete: () => complete?.(),
  }
}

export function currentRun(snapshot: AdmissionSnapshot, runId: RunId): AutopilotRun {
  const run = snapshot.runs.find((candidate) => candidate.runId === runId)
  if (run === undefined) throw new Error(`run "${runId}" disappeared from the admission aggregate`)
  return run
}

export function isPausedActive(run: AutopilotRun | undefined): run is PausedActiveRun {
  return run?.state === 'paused' && run.pause.kind === 'active'
}

export function sameGit(left: GitExecutionSnapshot, right: GitExecutionSnapshot): boolean {
  return left.baseHead === right.baseHead && left.head === right.head && left.status === right.status
}
