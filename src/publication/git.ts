import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { TerminalRun } from '../admission.js'
import type { CodeHostPublication } from '../code-host.js'
import { gitCommand } from '../dispatch/git.js'

const MAX_FILES = 100
const MAX_TREE_ENTRIES = 10_000
const MAX_FILE_BYTES = 512 * 1024
const MAX_TOTAL_BYTES = 2 * 1024 * 1024

/** Reconstruct and verify the bounded publication artifact from the exact durable local Git identities. */
export async function preparePublication(
  subprocess: SubprocessRuntime,
  run: TerminalRun,
  signal?: AbortSignal,
): Promise<CodeHostPublication> {
  if (
    (run.state !== 'publishing' && run.state !== 'completed') ||
    run.outcome.kind !== 'verified' ||
    run.publication === undefined
  ) {
    throw new Error('run is not a verified publication candidate')
  }
  const intent = run.publication
  const worktree = await realpath(run.execution.worktreePath)
  signal?.throwIfAborted()
  const root = await realpath((await gitCommand(subprocess, worktree, ['rev-parse', '--show-toplevel'], signal)).trim())
  if (root !== worktree) throw new Error('publication path is not the recorded Git worktree root')
  const branch = (await gitCommand(subprocess, worktree, ['rev-parse', '--abbrev-ref', 'HEAD'], signal)).trim()
  if (branch !== intent.headBranch) throw new Error('publication worktree branch changed after verification')
  const head = (await gitCommand(subprocess, worktree, ['rev-parse', 'HEAD'], signal)).trim()
  const baseHead = (await gitCommand(subprocess, worktree, ['rev-parse', intent.baseBranch], signal)).trim()
  const status = await gitCommand(subprocess, worktree, ['status', '--porcelain'], signal)
  if (head !== intent.localHead || head !== run.outcome.reportedGit.head || status !== run.outcome.reportedGit.status) {
    throw new Error('publication Git facts no longer match the verified outcome')
  }
  if (status !== '') throw new Error('publication requires a clean worktree')
  if (baseHead !== intent.baseHead) throw new Error('publication base changed after verification')
  if (head === baseHead) throw new Error('publication requires at least one committed change')
  await gitCommand(subprocess, worktree, ['merge-base', '--is-ancestor', baseHead, head], signal)
  const commitCount = Number(
    (await gitCommand(subprocess, worktree, ['rev-list', '--count', `${baseHead}..${head}`], signal)).trim(),
  )
  if (!Number.isSafeInteger(commitCount) || commitCount < 1 || commitCount > 100) {
    throw new Error('publication commit range exceeds its safety bound')
  }
  if (
    run.outcome.verification.length === 0 ||
    run.outcome.verification.some(
      (check) => check.status === 'failed' || (check.status === 'skipped' && check.reason === undefined),
    )
  ) {
    throw new Error('publication verification results are incomplete or failed')
  }

  const changed = parseChangedFiles(
    await gitCommand(
      subprocess,
      worktree,
      ['diff', '--name-status', '--no-renames', '-z', `${baseHead}..${head}`, '--'],
      signal,
    ),
  )
  if (changed.length === 0 || changed.length > MAX_FILES) throw new Error('publication file set is empty or too large')
  if (changed.some((entry) => entry.status !== 'A' && entry.status !== 'M')) {
    throw new Error('GitHub MCP publication does not support deleted or renamed paths')
  }
  if (!run.execution.codeHost.allowWorkflowChanges && changed.some((entry) => isWorkflow(entry.path))) {
    throw new Error('publication contains a workflow-file change forbidden by deployment policy')
  }

  let totalBytes = 0
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const files = []
  for (const entry of changed) {
    signal?.throwIfAborted()
    const absolute = resolve(worktree, entry.path)
    if (relative(worktree, absolute).startsWith('..') || dirname(absolute) === absolute) {
      throw new Error('publication contains an unsafe Git path')
    }
    const metadata = await lstat(absolute)
    if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) {
      throw new Error('GitHub MCP publication supports only bounded regular files')
    }
    const bytes = await readFile(absolute)
    totalBytes += bytes.byteLength
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('publication file content exceeds its safety bound')
    let content: string
    try {
      content = decoder.decode(bytes)
    } catch {
      throw new Error('GitHub MCP publication supports only UTF-8 file content')
    }
    files.push({ path: entry.path, content })
  }

  const tree = parseTree(await gitCommand(subprocess, worktree, ['ls-tree', '-r', '-z', head], signal))
  return {
    bindingId: intent.bindingId,
    repositoryId: intent.repositoryId,
    repository: intent.repository,
    baseBranch: intent.baseBranch,
    headBranch: intent.headBranch,
    baseHead: intent.baseHead,
    localHead: intent.localHead,
    tree,
    files,
    title: intent.title,
    body: intent.body,
    marker: intent.marker,
  }
}

/** Reconstruct the immutable durable publication identity for read-only remote reconciliation during cleanup. */
export async function preparePublicationReconciliation(
  subprocess: SubprocessRuntime,
  run: TerminalRun,
  signal?: AbortSignal,
): Promise<CodeHostPublication> {
  if (
    (run.state !== 'publishing' && run.state !== 'completed') ||
    run.outcome.kind !== 'verified' ||
    run.publication === undefined
  ) {
    throw new Error('run has no verified publication identity')
  }
  const intent = run.publication
  const tree = parseTree(
    await gitCommand(subprocess, run.execution.worktreePath, ['ls-tree', '-r', '-z', intent.localHead], signal),
  )
  return {
    bindingId: intent.bindingId,
    repositoryId: intent.repositoryId,
    repository: intent.repository,
    baseBranch: intent.baseBranch,
    headBranch: intent.headBranch,
    baseHead: intent.baseHead,
    localHead: intent.localHead,
    tree,
    files: [],
    title: intent.title,
    body: intent.body,
    marker: intent.marker,
  }
}

function parseChangedFiles(value: string): Array<{ status: string; path: string }> {
  const parts = value.split('\0')
  if (parts.at(-1) === '') parts.pop()
  if (parts.length % 2 !== 0) throw new Error('Git returned a malformed changed-file list')
  const result = []
  for (let index = 0; index < parts.length; index += 2) {
    const status = parts[index]
    const path = parts[index + 1]
    if (status === undefined || path === undefined || !/^[A-Z]$/.test(status) || path.length === 0) {
      throw new Error('Git returned a malformed changed-file entry')
    }
    result.push({ status, path })
  }
  return result
}

function parseTree(value: string): CodeHostPublication['tree'] {
  const records = value.split('\0')
  if (records.at(-1) === '') records.pop()
  if (records.length > MAX_TREE_ENTRIES) throw new Error('publication tree exceeds its safety bound')
  return records.map((record) => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(record)
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
      throw new Error('GitHub MCP publication supports only regular SHA-1 blob entries')
    }
    return { mode: match[1] as '100644' | '100755', type: 'blob' as const, sha: match[2], path: match[3] }
  })
}

function isWorkflow(path: string): boolean {
  return path.startsWith('.github/workflows/') && (path.endsWith('.yml') || path.endsWith('.yaml'))
}
