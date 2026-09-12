import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it } from 'vitest'
import * as Autopilot from '../src/index.js'
import { disposeContext, mountExecutionHostServices, mountHostServices } from './dsh-fixtures.js'

const contexts = new Set<Context>()
const temporaryDirectories = new Set<string>()

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.add(directory)
  return directory
}

function track(ctx: Context): Context {
  contexts.add(ctx)
  return ctx
}

afterEach(async () => {
  await Promise.allSettled([...contexts].map(disposeContext))
  contexts.clear()
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })))
  temporaryDirectories.clear()
})

describe('DSH plugin entry', () => {
  it('mounts its public services through named Cordis exports and disposes cleanly', async () => {
    const directory = await temporaryDirectory('dsh-autopilot-plugin-')
    const storePath = join(directory, 'state.sqlite')
    const ctx = track(await mountExecutionHostServices(storePath, join(directory, 'sessions')))
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const fiber = await ctx.plugin(Autopilot, { authoritativeStorePath: storePath })
    expect(ctx.tracker).toBeDefined()
    expect(ctx.dispatch).toBeDefined()
    expect(ctx.publication).toBeDefined()
    expect(ctx.delivery).toBeDefined()
    expect(ctx.autopilotWorkflow).toBeDefined()
    expect(ctx.runtimeOwner).toBeDefined()
    expect(ctx.pullRequestDisposition).toBeDefined()
    expect(ctx.autopilotOperations).toBeDefined()
    expect(ctx.autopilotOperations.health().persistence).toEqual({ status: 'ready' })
    expect(ctx.autopilotWebContributions).toBeDefined()
    expect(ctx.autopilotWebIntegrations).toBeDefined()
    expect(ctx.autopilotWeb).toBeDefined()
    expect(ctx.autopilotReconciliation).toBeDefined()
    expect(ctx.get('autopilotIngress')).toBeDefined()
    expect(ctx.admission.snapshot()).toEqual({
      revision: 0,
      runs: [],
      acceptedIngress: [],
      budget: { reservedTokens: 0, settledTokens: 0, usageUncertain: false },
      scheduler: { mode: 'enabled', changedAt: expect.any(String) as unknown },
    })
    await expect(fiber.dispose()).resolves.toBeUndefined()
    expect(ctx.get('tracker')).toBeUndefined()
    expect(ctx.get('admission')).toBeUndefined()
    expect(ctx.get('dispatch')).toBeUndefined()
    expect(ctx.get('publication')).toBeUndefined()
    expect(ctx.get('delivery')).toBeUndefined()
    expect(ctx.get('autopilotWorkflow')).toBeUndefined()
    expect(ctx.get('runtimeOwner')).toBeUndefined()
    expect(ctx.get('pullRequestDisposition')).toBeUndefined()
    expect(ctx.get('autopilotOperations')).toBeUndefined()
    expect(ctx.get('autopilotWebContributions')).toBeUndefined()
    expect(ctx.get('autopilotWebIntegrations')).toBeUndefined()
    expect(ctx.get('autopilotWeb')).toBeUndefined()
    expect(ctx.get('autopilotReconciliation')).toBeUndefined()
    expect(ctx.get('autopilotIngress')).toBeUndefined()
    const remounted = await ctx.plugin(Autopilot, { authoritativeStorePath: storePath })
    expect(ctx.tracker).toBeDefined()
    expect(ctx.dispatch).toBeDefined()
    expect(ctx.publication).toBeDefined()
    expect(ctx.delivery).toBeDefined()
    expect(ctx.autopilotWorkflow).toBeDefined()
    expect(ctx.runtimeOwner).toBeDefined()
    expect(ctx.pullRequestDisposition).toBeDefined()
    expect(ctx.autopilotOperations).toBeDefined()
    expect(ctx.autopilotWebContributions).toBeDefined()
    expect(ctx.autopilotWebIntegrations).toBeDefined()
    expect(ctx.autopilotWeb).toBeDefined()
    expect(ctx.autopilotReconciliation).toBeDefined()
    expect(ctx.get('autopilotIngress')).toBeDefined()
    expect(ctx.admission.snapshot()).toEqual({
      revision: 0,
      runs: [],
      acceptedIngress: [],
      budget: { reservedTokens: 0, settledTokens: 0, usageUncertain: false },
      scheduler: { mode: 'enabled', changedAt: expect.any(String) as unknown },
    })
    await expect(remounted.dispose()).resolves.toBeUndefined()
  })

  it('waits for its required DSH Host services', async () => {
    const ctx = track(new Context())
    const fiber = ctx.plugin(Autopilot)

    expect(ctx.get('tracker')).toBeUndefined()
    expect(ctx.get('admission')).toBeUndefined()

    await fiber.dispose()
  })

  it('keeps tracker admission available while execution-only services are absent', async () => {
    const directory = await temporaryDirectory('dsh-autopilot-plugin-admission-')
    const storePath = join(directory, 'state.sqlite')
    const ctx = track(await mountHostServices(storePath))
    const fiber = await ctx.plugin(Autopilot, { authoritativeStorePath: storePath })

    expect(ctx.tracker).toBeDefined()
    expect(ctx.admission).toBeDefined()
    expect(ctx.get('dispatch')).toBeUndefined()

    await fiber.dispose()
  })
})
