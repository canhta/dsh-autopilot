import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ExecutionOutcome, GitExecutionSnapshot, ImplementingRun, PausingRun } from '../admission.js'

const MAX_REPORT_TEXT_BYTES = 4 * 1024
const MAX_REPORT_EVIDENCE = 100
const textEncoder = new TextEncoder()

export interface ReportRecorder {
  outcome?: ExecutionOutcome
  violation?: string
}

export function createReportTool(recorder: ReportRecorder) {
  return defineTool({
    name: 'autopilot_report',
    description: 'Submit the single structured terminal report for this Autopilot fixture run.',
    parameters: {
      kind: { type: 'string', enum: ['verified', 'blocked', 'failed'], required: true },
      summary: { type: 'string', required: true },
      evidence: { type: 'array', items: { type: 'string' }, required: true },
      gitHead: { type: 'string' },
      gitStatus: { type: 'string' },
    },
    output: {
      schema: { type: 'string', const: 'accepted' },
      render: () => [{ type: 'text', text: 'Autopilot accepted the terminal report.' }],
    },
    async execute(args) {
      if (recorder.outcome !== undefined) {
        recorder.violation = 'the model submitted more than one terminal report'
        throw new Error(recorder.violation)
      }
      if (args.summary.length === 0 || textEncoder.encode(args.summary).byteLength > MAX_REPORT_TEXT_BYTES) {
        throw new TypeError('report summary must be non-empty and within its durable limit')
      }
      if (
        args.evidence.length > MAX_REPORT_EVIDENCE ||
        args.evidence.some(
          (entry) => entry.length === 0 || textEncoder.encode(entry).byteLength > MAX_REPORT_TEXT_BYTES,
        )
      ) {
        throw new TypeError('report evidence must contain only bounded non-empty entries')
      }
      if (args.kind === 'verified') {
        if (args.gitHead === undefined || !/^[a-f0-9]{40,64}$/.test(args.gitHead) || args.gitStatus === undefined) {
          throw new TypeError('verified reports require an exact Git head and status')
        }
        recorder.outcome = {
          kind: args.kind,
          summary: args.summary,
          evidence: [...args.evidence],
          reportedGit: { head: args.gitHead, status: args.gitStatus },
        }
      } else {
        if (args.gitHead !== undefined || args.gitStatus !== undefined) {
          throw new TypeError('blocked and failed reports must not claim verified Git facts')
        }
        recorder.outcome = { kind: args.kind, summary: args.summary, evidence: [...args.evidence] }
      }
      return 'accepted' as const
    },
  })
}

export function validatedOutcome(report: ReportRecorder, git: GitExecutionSnapshot): ExecutionOutcome {
  if (report.violation !== undefined) {
    return { kind: 'failed', summary: 'The fixture model violated the report contract.', evidence: [report.violation] }
  }
  if (report.outcome === undefined) {
    return { kind: 'failed', summary: 'The fixture model did not submit a terminal report.', evidence: [] }
  }
  if (
    report.outcome.kind === 'verified' &&
    (report.outcome.reportedGit.head !== git.head || report.outcome.reportedGit.status !== git.status)
  ) {
    return {
      kind: 'failed',
      summary: 'The fixture model reported Git facts that do not match the managed worktree.',
      evidence: [truncateUtf8(`head=${git.head}\nstatus=${git.status}`)],
    }
  }
  return report.outcome
}

export function executionPrompt(run: ImplementingRun | PausingRun): string {
  const git = run.execution.git
  if (git === undefined) throw new Error('the managed worktree has no durable Git facts')
  return `Execute the approved Agent Brief below in the managed fixture worktree. Use autopilot_report exactly once with a verified, blocked, or failed outcome before finishing. A verified report must repeat the exact final Git head and porcelain status.\n\nManaged Git head: ${git.head}\nManaged Git status: ${JSON.stringify(git.status)}\n\n${run.brief.content}`
}

export function continuationPrompt(run: ImplementingRun): string {
  const git = run.execution.git
  if (git === undefined) throw new Error('the managed worktree has no durable Git facts')
  return `Continue the approved Agent Brief in this same persisted Session and managed worktree. Reconcile any interrupted operation from the prior pause before repeating a side effect. Use autopilot_report exactly once with a verified, blocked, or failed outcome before finishing. A verified report must repeat the exact final Git head and porcelain status.\n\nManaged Git head: ${git.head}\nManaged Git status: ${JSON.stringify(git.status)}\n\n${run.brief.content}`
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message || 'unknown fixture dispatch failure'
}

export function truncateUtf8(value: string): string {
  if (textEncoder.encode(value).byteLength <= MAX_REPORT_TEXT_BYTES) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (textEncoder.encode(value.slice(0, middle)).byteLength <= MAX_REPORT_TEXT_BYTES) low = middle
    else high = middle - 1
  }
  return value.slice(0, low)
}
