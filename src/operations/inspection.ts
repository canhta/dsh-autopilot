import { createHash } from 'node:crypto'
import { access, lstat, opendir, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AdmissionSnapshot, AutopilotRun, RunExecutionSnapshot, RunId } from '../admission.js'
import { gitCommand } from '../dispatch/git.js'
import type { PullRequestDisposition } from './disposition.js'
import type { CleanupRejection } from './model.js'

export type AllocatedRun = AutopilotRun & { readonly execution: RunExecutionSnapshot }

export function cleanupRejections(input: {
  run: AllocatedRun
  disposition: PullRequestDisposition
  ownership: boolean
  missing: boolean
  dirtyFiles: readonly string[]
  untrackedFiles: readonly string[]
  unpushedCommits: number | 'unknown'
  retentionEligibleAt?: string
  now: number
}): CleanupRejection[] {
  const reasons: CleanupRejection[] = []
  switch (input.run.state) {
    case 'queued':
    case 'implementing':
    case 'pausing':
      reasons.push('run-active')
      break
    case 'paused':
      reasons.push('run-paused')
      break
    case 'publishing':
      reasons.push('run-publishing')
      break
    case 'blocked':
      reasons.push('run-blocked')
      break
    case 'failed':
      reasons.push('run-failed')
      break
    case 'completed':
      if (hasUnresolvedExternalIntent(input.run, true)) {
        reasons.push('external-intent-unresolved')
      }
      break
    case 'cancelled':
      if (hasUnresolvedExternalIntent(input.run, false)) reasons.push('external-intent-unresolved')
      break
    default:
      input.run satisfies never
  }
  if (input.run.execution.recovery !== undefined) reasons.push('recovery-required')
  if (!input.ownership) reasons.push(input.missing ? 'worktree-missing' : 'ownership-unproven')
  if (input.dirtyFiles.length > 0) reasons.push('dirty-files')
  if (input.untrackedFiles.length > 0) reasons.push('untracked-files')
  if (input.unpushedCommits === 'unknown' || input.unpushedCommits > 0) reasons.push('unpushed-commits')
  if (input.disposition.state === 'open') reasons.push('pr-open')
  else if (input.disposition.state === 'unknown') reasons.push('pr-unknown')
  else if (input.disposition.state === 'closed-unmerged') reasons.push('pr-closed-unmerged')
  if (input.retentionEligibleAt === undefined || Date.parse(input.retentionEligibleAt) > input.now) {
    reasons.push('retention-not-met')
  }
  return [...new Set(reasons)]
}

function hasUnresolvedExternalIntent(run: AllocatedRun, publicationRequired: boolean): boolean {
  const publication = 'publication' in run ? run.publication : undefined
  return (
    (publicationRequired && publication === undefined) ||
    (publication !== undefined && (publication.status !== 'succeeded' || publication.receipt === undefined)) ||
    run.deliveries.some((delivery) =>
      ['pending', 'in-flight', 'uncertain', 'retryable-failure', 'exhausted'].includes(delivery.status),
    )
  )
}

export async function inspectOwnership(ctx: Context, run: AllocatedRun, managedRoot: string): Promise<void> {
  const expected = resolve(managedRoot, run.runId)
  if (resolve(run.execution.worktreePath) !== expected)
    throw new Error('recorded path is not the configured run-owned path')
  const [root, worktree, repository, observedRoot, common, targetCommon] = await Promise.all([
    canonicalExistingPath(managedRoot),
    canonicalExistingPath(run.execution.worktreePath),
    canonicalExistingPath(run.execution.targetRepository),
    gitCommand(ctx.subprocess, run.execution.worktreePath, ['rev-parse', '--show-toplevel']),
    gitCommand(ctx.subprocess, run.execution.worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    gitCommand(ctx.subprocess, run.execution.targetRepository, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]),
  ])
  if (!inside(root, worktree) || resolve(root, run.runId) !== worktree)
    throw new Error('worktree escaped its managed root')
  if ((await canonicalExistingPath(observedRoot.trim())) !== worktree)
    throw new Error('Git top level differs from recorded path')
  if ((await canonicalExistingPath(common.trim())) !== (await canonicalExistingPath(targetCommon.trim()))) {
    throw new Error('worktree does not belong to the recorded target repository')
  }
  const branch = (await gitCommand(ctx.subprocess, worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  if (branch !== run.execution.branch) throw new Error('worktree branch differs from durable ownership')
  const registered = await listWorktrees(ctx, repository)
  if (!registered.some((entry) => resolve(entry.path) === worktree))
    throw new Error('Git does not register the worktree')
}

export async function listWorktrees(ctx: Context, repository: string): Promise<{ path: string; branch?: string }[]> {
  if (repository === '') return []
  const output = await gitCommand(ctx.subprocess, repository, ['worktree', 'list', '--porcelain', '-z'])
  const result: { path: string; branch?: string }[] = []
  let current: { path: string; branch?: string } | undefined
  for (const field of output.split('\0')) {
    if (field === '') {
      if (current !== undefined) result.push(current)
      current = undefined
    } else if (field.startsWith('worktree ')) {
      if (current !== undefined) result.push(current)
      current = { path: field.slice('worktree '.length) }
    } else if (field.startsWith('branch ') && current !== undefined) {
      current.branch = field.slice('branch refs/heads/'.length)
    }
  }
  if (current !== undefined) result.push(current)
  return result
}

export function parseStatus(status: string): { dirtyFiles: string[]; untrackedFiles: string[] } {
  const dirtyFiles: string[] = []
  const untrackedFiles: string[] = []
  for (const entry of status.split('\0')) {
    if (entry.length < 4 || entry[2] !== ' ') continue
    const path = entry.slice(3)
    if (entry.startsWith('?? ')) untrackedFiles.push(path)
    else dirtyFiles.push(path)
  }
  return { dirtyFiles, untrackedFiles }
}

export async function directoryBytes(path: string): Promise<number> {
  const metadata = await lstat(path)
  if (!metadata.isDirectory()) return metadata.size
  let total = metadata.size
  const directory = await opendir(path)
  for await (const entry of directory) {
    const child = join(path, entry.name)
    const childMetadata = await lstat(child)
    total +=
      childMetadata.isDirectory() && !childMetadata.isSymbolicLink() ? await directoryBytes(child) : childMetadata.size
  }
  return total
}

export function allocatedRun(snapshot: AdmissionSnapshot, runId: RunId): AllocatedRun {
  const run = snapshot.runs.find((candidate) => candidate.runId === runId)
  if (run === undefined) throw new Error(`run "${runId}" does not exist`)
  if (!hasExecution(run)) throw new Error(`run "${runId}" has no allocated worktree`)
  return run
}

export function hasExecution(run: AutopilotRun): run is AllocatedRun {
  return 'execution' in run
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export async function canonicalExistingPath(path: string): Promise<string> {
  return resolve(await realpath(path))
}

export function inside(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !child.startsWith(sep)
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length <= 4096 ? message : message.slice(0, 4096)
}
