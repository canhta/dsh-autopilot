import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as Autopilot from '../src/index.js'

describe('DSH plugin entry', () => {
  it('mounts through named Cordis exports and disposes cleanly', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(Autopilot)
    await expect(fiber.dispose()).resolves.toBeUndefined()
  })
})
