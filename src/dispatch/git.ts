import { realpath } from 'node:fs/promises'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { GitExecutionSnapshot, PausedActiveRun } from '../admission.js'

const GIT_OUTPUT_LIMIT = 1024 * 1024
const GIT_GRACE_MS = 5_000
const GIT_TIMEOUT_MS = 30_000

export async function inspectRetainedWorktree(
  subprocess: SubprocessRuntime,
  run: PausedActiveRun,
): Promise<GitExecutionSnapshot> {
  const retainedGit = run.execution.git
  if (retainedGit === undefined) throw new Error('the retained run has no Git checkpoint')
  const observedRoot = await gitCommand(subprocess, run.execution.worktreePath, ['rev-parse', '--show-toplevel'])
  const observedBranch = await gitCommand(subprocess, run.execution.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const observedCommonDirectory = await gitCommand(subprocess, run.execution.worktreePath, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ])
  const targetCommonDirectory = await gitCommand(subprocess, run.execution.targetRepository, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ])
  const [canonicalRoot, canonicalWorktree, canonicalCommonDirectory, canonicalTargetCommonDirectory] =
    await Promise.all([
      realpath(observedRoot.trim()),
      realpath(run.execution.worktreePath),
      realpath(observedCommonDirectory.trim()),
      realpath(targetCommonDirectory.trim()),
    ])
  if (
    canonicalRoot !== canonicalWorktree ||
    canonicalCommonDirectory !== canonicalTargetCommonDirectory ||
    observedBranch.trim() !== run.execution.branch
  ) {
    throw new Error('the retained path is not the recorded managed Git worktree and branch')
  }
  return await inspectGit(subprocess, run.execution.worktreePath, retainedGit.baseHead)
}

export async function inspectGit(
  subprocess: SubprocessRuntime,
  worktreePath: string,
  baseHead: string,
): Promise<GitExecutionSnapshot> {
  const head = (await gitCommand(subprocess, worktreePath, ['rev-parse', 'HEAD'])).trim()
  const status = await gitCommand(subprocess, worktreePath, ['status', '--porcelain'])
  return { baseHead, head, status }
}

export async function gitCommand(subprocess: SubprocessRuntime, cwd: string, args: readonly string[]): Promise<string> {
  const executable = await subprocess.resolveExecutable('git')
  const signal = AbortSignal.timeout(GIT_TIMEOUT_MS)
  const handle = subprocess.spawn({
    argv: [executable, ...args],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: GIT_OUTPUT_LIMIT },
      stderr: { maxBytes: GIT_OUTPUT_LIMIT },
    },
    graceMs: GIT_GRACE_MS,
    signal,
  })
  let outcome: Awaited<typeof handle.done> | undefined
  let commandError: unknown
  try {
    outcome = await handle.done
  } catch (error) {
    commandError = error
  }
  let quiescenceError: unknown
  try {
    if (!(await handle.waitForExit(AbortSignal.timeout(GIT_GRACE_MS * 2)))) {
      quiescenceError = new Error(`git ${args[0] ?? ''} left a live managed process`)
    }
  } catch (error) {
    quiescenceError = error
  }
  if (commandError !== undefined) {
    if (quiescenceError !== undefined) {
      throw new AggregateError([commandError, quiescenceError], `git ${args[0] ?? ''} failed and did not quiesce`)
    }
    throw commandError
  }
  if (quiescenceError !== undefined) throw quiescenceError
  if (outcome === undefined) throw new Error(`git ${args[0] ?? ''} produced no process outcome`)
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  if (stdout?.lossy || stderr?.lossy) throw new Error(`git ${args[0] ?? ''} output exceeded its safety bound`)
  if (signal.aborted) throw new Error(`git ${args.join(' ')} timed out`)
  if (outcome.exitCode !== 0) {
    const diagnostic = stderr?.text.trim() || stdout?.text.trim() || `exit ${String(outcome.exitCode)}`
    throw new Error(`git ${args.join(' ')} failed: ${diagnostic}`)
  }
  return stdout?.text ?? ''
}
