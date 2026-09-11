import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as Autopilot from '../src/index.js'
import { disposeContext, mountExecutionHostServices } from './dsh-fixtures.js'

describe('DSH plugin entry', () => {
  it('mounts its public services through named Cordis exports and disposes cleanly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-autopilot-plugin-'))
    const ctx = await mountExecutionHostServices(join(directory, 'state.sqlite'), join(directory, 'sessions'))
    const fiber = await ctx.plugin(Autopilot)
    expect(ctx.tracker).toBeDefined()
    expect(ctx.dispatch).toBeDefined()
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
    const remounted = await ctx.plugin(Autopilot)
    expect(ctx.tracker).toBeDefined()
    expect(ctx.dispatch).toBeDefined()
    expect(ctx.admission.snapshot()).toEqual({
      revision: 0,
      runs: [],
      acceptedIngress: [],
      budget: { reservedTokens: 0, settledTokens: 0, usageUncertain: false },
      scheduler: { mode: 'enabled', changedAt: expect.any(String) as unknown },
    })
    await expect(remounted.dispose()).resolves.toBeUndefined()
    await disposeContext(ctx)
    await rm(directory, { recursive: true, force: true })
  })

  it('waits for its required DSH Host services', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(Autopilot)

    expect(ctx.get('tracker')).toBeUndefined()
    expect(ctx.get('admission')).toBeUndefined()

    await fiber.dispose()
  })
})
