import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  type GenerateOptions,
  LlmAdapter,
  type LlmResolvedModelInfo,
  type StreamChunk,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { afterEach, expect } from 'vitest'
import { Admission, type PausedActiveRun } from '../src/admission.js'
import { AutopilotConfig } from '../src/config.js'
import { Dispatch, FIXTURE_PROVIDER } from '../src/dispatch.js'
import { createFixtureTrackerProvider } from '../src/testing.js'
import {
  readinessGeneration,
  Tracker,
  type TrackerIssueSnapshot,
  trackerBindingId,
  trackerCommentId,
  trackerIssueId,
} from '../src/tracker.js'
import { disposeContext, fixtureExecutionSettings, mountExecutionHostServices } from './dsh-fixtures.js'

export const temporaryDirectories: string[] = []
export const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(disposeContext))
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

export class ControlledAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private response = 0

  constructor(
    private readonly reportKind: 'verified' | 'blocked' | 'failed' = 'verified',
    private readonly usageMode: 'known' | 'missing' | 'over' = 'known',
    private readonly reportMode:
      | 'valid'
      | 'missing'
      | 'malformed'
      | 'multiple'
      | 'empty'
      | 'exact-multibyte'
      | 'oversized' = 'valid',
    private readonly beforeFirstResponse?: () => Promise<void>,
    private readonly reportOnResume = false,
    private readonly firstUnapprovedTool?: string,
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.response += 1
    if (this.response === 1) await this.beforeFirstResponse?.()

    if (this.response === 1 && this.firstUnapprovedTool !== undefined) {
      yield* this.toolResponse(`unapproved-${String(this.response)}`, this.firstUnapprovedTool, {})
      return
    }

    if (this.reportMode === 'missing') {
      yield* this.textResponse()
      return
    }

    if (
      this.response === 1 ||
      (this.firstUnapprovedTool !== undefined && this.response === 2) ||
      (this.reportOnResume && this.response === 3) ||
      (this.reportMode === 'multiple' && this.response === 2)
    ) {
      const { head, status } = managedGitFrom(options)
      const summary =
        this.reportMode === 'empty'
          ? ''
          : this.reportMode === 'exact-multibyte'
            ? '😀'.repeat(1024)
            : this.reportMode === 'oversized'
              ? '😀'.repeat(1025)
              : 'The fixture run completed and its clean Git state was verified.'
      const report: Record<string, unknown> = {
        kind: this.reportKind,
        summary,
        evidence: this.reportMode === 'malformed' ? [1] : ['controlled-model', 'clean-worktree'],
      }
      if (this.reportKind === 'verified') Object.assign(report, { gitHead: head, gitStatus: status })
      yield* this.toolResponse(`report-${String(this.response)}`, 'autopilot_report', report)
      return
    }

    yield* this.textResponse()
  }

  private *toolResponse(id: string, name: string, args: Record<string, unknown>): Iterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield {
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id: ToolCallId(id),
        name,
        arguments: JSON.stringify(args),
      },
    }
    if (this.usageMode !== 'missing') {
      yield {
        type: 'usage',
        usage:
          this.usageMode === 'over'
            ? { inputTokens: 70, outputTokens: 3, cacheReadTokens: 2 }
            : { inputTokens: 7, outputTokens: 3, cacheReadTokens: 2 },
      }
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }

  private *textResponse(): Iterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    if (this.usageMode !== 'missing') yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function managedGitFrom(options: GenerateOptions): { head: string; status: string } {
  const text = options.messages
    .flatMap((message) => message.content)
    .filter(
      (block): block is Extract<(typeof options.messages)[number]['content'][number], { type: 'text' }> =>
        block.type === 'text',
    )
    .map((block) => block.text)
    .join('\n')
  const match = /Managed Git head: ([a-f0-9]{40,64})\nManaged Git status: ("(?:[^"\\]|\\.)*")/.exec(text)
  if (match?.[1] === undefined || match[2] === undefined) throw new Error('fixture request omitted managed Git facts')
  return { head: match[1], status: JSON.parse(match[2]) as string }
}

const brief = `# Agent Brief

dsh-autopilot:brief:v1

## Objective
Exercise one durable fixture dispatch.

## In scope
The managed worktree, native Agent and structured completion report.

## Acceptance criteria
- The controlled model reports a verified outcome.

## Constraints
Use only the fixture model route.

## Context
Issue #7 defines this execution slice.`

export function candidate(overrides: Partial<TrackerIssueSnapshot> = {}): TrackerIssueSnapshot {
  return {
    bindingId: trackerBindingId('fixture:project'),
    issueId: trackerIssueId('issue-7'),
    displayKey: 'FIX-7',
    summary: 'Exercise durable dispatch',
    priorityRank: 1,
    isReady: true,
    labels: ['ready-for-agent'],
    comments: [
      {
        id: trackerCommentId('brief-7'),
        authorId: 'person-1',
        body: brief,
        updatedAt: '2026-09-11T00:00:00.000Z',
      },
    ],
    dependencies: [],
    readiness: {
      kind: 'transition',
      generation: readinessGeneration('transition-7'),
      actorId: 'person-1',
      actorKind: 'human',
      occurredAt: '2026-09-11T00:00:00.000Z',
    },
    ...overrides,
  }
}

export function restartCandidate(): TrackerIssueSnapshot {
  const issue = candidate()
  return {
    ...issue,
    bindingId: trackerBindingId('fixture:restart'),
    issueId: trackerIssueId('issue-7-restart'),
    displayKey: 'FIX-7-RESTART',
    readiness: {
      kind: 'transition',
      generation: readinessGeneration('transition-7-restart'),
      actorId: 'person-1',
      actorKind: 'human',
      occurredAt: '2026-09-11T00:00:00.000Z',
    },
  }
}

export async function createTargetRepository(root: string): Promise<string> {
  const repository = join(root, 'target')
  await mkdir(repository)
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repository })
  execFileSync('git', ['config', 'user.name', 'Fixture User'], { cwd: repository })
  execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository })
  await writeFile(join(repository, 'README.md'), 'fixture\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repository })
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repository })
  return repository
}

export async function bootFixture(
  root: string,
  adapter: ControlledAdapter,
  issues: readonly TrackerIssueSnapshot[] = [candidate()],
): Promise<Context> {
  const repository = await createTargetRepository(root)
  const worktreeRoot = join(root, 'worktrees')
  const sessionRoot = join(root, 'sessions')
  await mkdir(worktreeRoot)
  await mkdir(sessionRoot)
  const ctx = await mountExecutionHostServices(join(root, 'state.sqlite'), sessionRoot, {
    'dsh-autopilot': {
      trackerProvider: 'fixture',
      ...fixtureExecutionSettings(repository, worktreeRoot),
    },
  })
  contexts.push(ctx)
  ctx.llm.registerAdapter([FIXTURE_PROVIDER], adapter)
  await ctx.plugin(Tracker)
  ctx.tracker.register(createFixtureTrackerProvider({ issues }))
  await ctx.plugin(AutopilotConfig)
  await ctx.plugin(Admission)
  await ctx.plugin(Dispatch)
  await ctx.admission.reconcile({ source: 'manual' })
  return ctx
}

export async function pauseAtSettlement(ctx: Context): Promise<PausedActiveRun> {
  const recordWorktree = ctx.admission.recordWorktree.bind(ctx.admission)
  let recordCount = 0
  let disabling: Promise<unknown> | undefined
  ctx.admission.recordWorktree = async (runId, git) => {
    const recorded = await recordWorktree(runId, git)
    recordCount += 1
    if (recordCount === 2) {
      disabling = ctx.dispatch.disableScheduler()
      await expect.poll(() => ctx.admission.snapshot().runs[0]?.state).toBe('pausing')
    }
    return recorded
  }
  const paused = await ctx.dispatch.dispatchNext()
  await disabling
  if (paused === undefined || paused.state !== 'paused' || paused.pause.kind !== 'active') {
    throw new Error('expected an allocated pause checkpoint')
  }
  return paused
}
