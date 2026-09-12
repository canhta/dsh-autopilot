import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Admission } from '../src/admission.js'
import { AutopilotConfig } from '../src/config.js'
import { Ingress, TRACKER_INGRESS_PATH } from '../src/ingress.js'
import { Reconciliation } from '../src/reconciliation.js'
import { createFixtureTrackerProvider } from '../src/testing.js'
import { Tracker } from '../src/tracker.js'
import { disposeContext, mountHostServices } from './dsh-fixtures.js'

const contexts = new Set<Context>()
const temporaryDirectories = new Set<string>()

afterEach(async () => {
  await Promise.allSettled([...contexts].map(disposeContext))
  contexts.clear()
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })))
  temporaryDirectories.clear()
})

describe('tracker ingress HTTP lifecycle', () => {
  it('aborts and drains a partial body before a retired route can call reconciliation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-autopilot-ingress-lifecycle-'))
    temporaryDirectories.add(directory)
    const ctx = await mountHostServices(join(directory, 'state.sqlite'), {
      'dsh-autopilot': { trackerProvider: 'fixture' },
    })
    contexts.add(ctx)
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(Tracker)
    ctx.tracker.register(createFixtureTrackerProvider({ issues: [] }))
    await ctx.plugin(AutopilotConfig)
    await ctx.plugin(Admission)
    await ctx.plugin(Reconciliation)
    const ingress = await ctx.plugin(Ingress)
    await vi.waitFor(() => {
      expect(ctx.autopilotReconciliation.snapshot().lastAttempt).toMatchObject({
        source: 'startup',
        outcome: 'succeeded',
      })
    })
    const acceptIngress = vi.spyOn(ctx.autopilotReconciliation, 'acceptIngress')

    let resolveClientFailure: (error: Error) => void = () => undefined
    const clientFailure = new Promise<Error>((resolve) => {
      resolveClientFailure = resolve
    })
    let resolveContinue: () => void = () => undefined
    const continued = new Promise<void>((resolve) => {
      resolveContinue = resolve
    })
    const client = httpRequest({
      host: '127.0.0.1',
      port: ctx.webServer.port,
      path: TRACKER_INGRESS_PATH,
      method: 'POST',
      headers: { 'content-length': '2', expect: '100-continue' },
    })
    client.on('error', resolveClientFailure)
    client.once('continue', resolveContinue)
    client.flushHeaders()
    await continued
    client.write('x')
    await new Promise<void>((resolve) => setImmediate(resolve))

    await ingress.dispose()

    await expect(clientFailure).resolves.toBeInstanceOf(Error)
    expect(acceptIngress).not.toHaveBeenCalled()
  })
})
