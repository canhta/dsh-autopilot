import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach } from 'vitest'
import { Admission } from '../src/admission.js'
import { AutopilotConfig } from '../src/config.js'
import { createFixtureTrackerProvider } from '../src/testing.js'
import {
  readinessGeneration,
  Tracker,
  type TrackerComment,
  type TrackerIssueSnapshot,
  type TrackerProvider,
  trackerBindingId,
  trackerCommentId,
  trackerIssueId,
} from '../src/tracker.js'
import { disposeContext, mountHostServices } from './dsh-fixtures.js'

const temporaryDirectories: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(disposeContext))
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

export function trackContext(ctx: Context): Context {
  contexts.push(ctx)
  return ctx
}

export async function disposeTrackedContext(ctx: Context): Promise<void> {
  const index = contexts.indexOf(ctx)
  if (index >= 0) contexts.splice(index, 1)
  await disposeContext(ctx)
}

export const validBrief = `# Agent Brief

dsh-autopilot:brief:v1

## Objective
Implement durable tracker admission.

## In scope
The public admission service and fixture provider.

## Acceptance criteria
- Duplicate reconciliation produces one queued run.

## Constraints
Do not make external writes.

## Context
Issue #6 defines the product slice.`

export function briefComment(overrides: Partial<TrackerComment> = {}): TrackerComment {
  return {
    id: trackerCommentId('comment-1'),
    authorId: 'person-1',
    body: validBrief,
    updatedAt: '2026-09-11T00:00:00.000Z',
    ...overrides,
  }
}

export function candidate(overrides: Partial<TrackerIssueSnapshot> = {}): TrackerIssueSnapshot {
  return {
    bindingId: trackerBindingId('fixture:project'),
    issueId: trackerIssueId('issue-1'),
    displayKey: 'FIX-1',
    summary: 'Implement durable tracker admission',
    priorityRank: 2,
    isReady: true,
    labels: ['ready-for-agent'],
    comments: [briefComment()],
    dependencies: [],
    readiness: {
      kind: 'transition',
      generation: readinessGeneration('transition-1'),
      actorId: 'person-1',
      actorKind: 'human',
      occurredAt: '2026-09-11T00:00:00.000Z',
    },
    ...overrides,
  }
}

export function fixtureProvider(issues: readonly TrackerIssueSnapshot[], onRead?: () => void): TrackerProvider {
  return createFixtureTrackerProvider({
    issues,
    readCandidates: () => {
      onRead?.()
      return Promise.resolve({ issues })
    },
  })
}

export async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-autopilot-admission-'))
  temporaryDirectories.push(directory)
  return join(directory, 'state.sqlite')
}

export function useDatabase<T>(path: string, operation: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(path)
  try {
    return operation(database)
  } finally {
    database.close()
  }
}

export function rejectAdmissionUpdates(path: string): void {
  useDatabase(path, (database) => {
    database.exec(`CREATE TRIGGER reject_admission_update
      BEFORE UPDATE ON u_autopilot_admission_state
      BEGIN
        SELECT RAISE(ABORT, 'forced durable failure');
      END`)
  })
}

interface StoredRun {
  runId: string
  providerId: string
  bindingId: string
  issueId: string
  readinessGeneration: string
  summary: string
  queueSequence: number
  brief: { commentId: string; content: string; digest: string }
}

export interface StoredAdmissionState {
  schemaVersion: number
  nextSequence: number
  runs: StoredRun[]
  acceptedIngress: string[]
}

export function rewriteStoredState(path: string, mutate: (state: StoredAdmissionState) => void): void {
  useDatabase(path, (database) => {
    const stored = database.prepare('SELECT value FROM u_autopilot_admission_state WHERE key = ?').get('primary') as {
      value: string
    }
    const state = JSON.parse(stored.value) as StoredAdmissionState
    mutate(state)
    database
      .prepare('UPDATE u_autopilot_admission_state SET value = ? WHERE key = ?')
      .run(JSON.stringify(state), 'primary')
  })
}

export function deterministicRunId(run: StoredRun): string {
  const identity = JSON.stringify([run.providerId, run.bindingId, run.issueId, run.readinessGeneration])
  return `run_${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
}

export async function boot(
  path: string,
  issues: readonly TrackerIssueSnapshot[],
  maxQueued = 20,
  admissionSettings: Record<string, unknown> = {},
  onRead?: () => void,
) {
  const ctx = trackContext(
    await mountHostServices(path, {
      'dsh-autopilot': {
        trackerProvider: 'fixture',
        maxQueued,
        ...admissionSettings,
      },
    }),
  )
  await ctx.plugin(Tracker)
  const disposeProvider = ctx.tracker.register(fixtureProvider(issues, onRead))
  await ctx.plugin(AutopilotConfig)
  await ctx.plugin(Admission)
  return { ctx, disposeProvider }
}
