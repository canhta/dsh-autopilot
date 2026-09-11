import type { Context } from '@deepseek-ai/cordis'
import { type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, it } from 'vitest'
import { Admission } from '../../src/admission.js'
import { Dispatch, FIXTURE_PROVIDER } from '../../src/dispatch.js'
import { createFixtureTrackerProvider } from '../../src/testing.js'
import {
  readinessGeneration,
  Tracker,
  type TrackerIssueSnapshot,
  trackerBindingId,
  trackerCommentId,
  trackerIssueId,
} from '../../src/tracker.js'
import { fixtureExecutionSettings, mountExecutionHostServices } from '../dsh-fixtures.js'

const root = process.env.DSH_AUTOPILOT_CRASH_ROOT

class CrashAfterDurabilityAdapter extends LlmAdapter {
  constructor(private readonly ctx: Context) {
    super()
  }

  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    await this.ctx.sessionPersistence.flush()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    process.kill(process.pid, 'SIGKILL')
  }
}

function candidate(): TrackerIssueSnapshot {
  return {
    bindingId: trackerBindingId('fixture:restart'),
    issueId: trackerIssueId('issue-7-restart'),
    displayKey: 'FIX-7-RESTART',
    summary: 'Exercise abrupt durable restart',
    priorityRank: 1,
    isReady: true,
    labels: ['ready-for-agent'],
    comments: [
      {
        id: trackerCommentId('brief-7-restart'),
        authorId: 'person-1',
        body: `# Agent Brief

dsh-autopilot:brief:v1

## Objective
Exercise abrupt durable restart.

## In scope
One fixture dispatch.

## Acceptance criteria
- Durable identities survive.

## Constraints
Crash only the isolated test Host.

## Context
Issue #7 defines restart recovery.`,
        updatedAt: '2026-09-11T00:00:00.000Z',
      },
    ],
    dependencies: [],
    readiness: {
      kind: 'transition',
      generation: readinessGeneration('transition-7-restart'),
      actorId: 'person-1',
      actorKind: 'human',
      occurredAt: '2026-09-11T00:00:00.000Z',
    },
  }
}

describe.skipIf(root === undefined)('isolated crash fixture', () => {
  it('terminates after the native Session and worktree are durable', async () => {
    if (root === undefined) throw new Error('missing crash fixture root')
    const repository = process.env.DSH_AUTOPILOT_CRASH_REPOSITORY
    if (repository === undefined) throw new Error('missing crash fixture repository')
    const ctx = await mountExecutionHostServices(`${root}/state.sqlite`, `${root}/sessions`, {
      'dsh-autopilot': {
        trackerProvider: 'fixture',
        ...fixtureExecutionSettings(repository, `${root}/worktrees`),
      },
    })
    ctx.llm.registerAdapter([FIXTURE_PROVIDER], new CrashAfterDurabilityAdapter(ctx))
    await ctx.plugin(Tracker)
    ctx.tracker.register(createFixtureTrackerProvider({ issues: [candidate()] }))
    await ctx.plugin(Admission)
    await ctx.plugin(Dispatch)
    await ctx.admission.reconcile({ source: 'manual' })

    await ctx.dispatch.dispatchNext()
    throw new Error('the isolated Host did not terminate')
  })
})
