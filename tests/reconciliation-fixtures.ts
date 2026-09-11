import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, vi } from 'vitest'
import { Admission } from '../src/admission.js'
import { AutopilotConfig } from '../src/config.js'
import { Ingress } from '../src/ingress.js'
import { Reconciliation } from '../src/reconciliation.js'
import { readinessGeneration, Tracker, trackerBindingId, trackerCommentId, trackerIssueId } from '../src/tracker.js'
import { disposeContext, mountHostServices } from './dsh-fixtures.js'

export const contexts = new Set<Context>()
const temporaryDirectories = new Set<string>()

interface ReconciliationHarness {
  readonly ctx: Context
  readonly storagePath: string
}

export async function createHarness(
  prefix: string,
  settings: Record<string, unknown>,
  withWebServer = false,
): Promise<ReconciliationHarness> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.add(directory)
  const storagePath = join(directory, 'state.sqlite')
  const ctx = await mountHostServices(storagePath, settings)
  contexts.add(ctx)
  if (withWebServer) await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(Tracker)
  return { ctx, storagePath }
}

export async function mountReconciliation(ctx: Context): Promise<Fiber> {
  await ctx.plugin(AutopilotConfig)
  await ctx.plugin(Admission)
  return ctx.plugin(Reconciliation)
}

export async function mountIngress(ctx: Context): Promise<Fiber> {
  const reconciliation = await mountReconciliation(ctx)
  await ctx.plugin(Ingress)
  return reconciliation
}

export async function disposeTrackedContext(ctx: Context): Promise<void> {
  contexts.delete(ctx)
  await disposeContext(ctx)
}

export const candidate = {
  bindingId: trackerBindingId('fixture:project'),
  issueId: trackerIssueId('issue-1'),
  displayKey: 'FIX-1',
  summary: 'Reconcile safely',
  priorityRank: 1,
  isReady: true,
  labels: ['ready-for-agent'],
  comments: [
    {
      id: trackerCommentId('brief-1'),
      authorId: 'person-1',
      updatedAt: '2026-09-11T00:00:00.000Z',
      body: `# Agent Brief
dsh-autopilot:brief:v1
## Objective
Ship it.
## In Scope
Reconciliation.
## Acceptance Criteria
It works.
## Constraints
Keep state durable.
## Context
Fixture.`,
    },
  ],
  dependencies: [],
  readiness: {
    kind: 'transition' as const,
    generation: readinessGeneration('transition-1'),
    actorId: 'person-1',
    actorKind: 'human' as const,
    occurredAt: '2026-09-11T00:01:00.000Z',
  },
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.allSettled([...contexts].map(disposeContext))
  contexts.clear()
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })))
  temporaryDirectories.clear()
})
