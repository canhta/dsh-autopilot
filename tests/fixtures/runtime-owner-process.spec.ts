import { describe, expect, it } from 'vitest'
import { AutopilotConfig } from '../../src/config.js'
import { RuntimeOwner, RuntimeStoreOwnedError } from '../../src/operations.js'
import { disposeContext, mountHostServices } from '../dsh-fixtures.js'

const storePath = process.env.DSH_AUTOPILOT_OWNER_STORE

describe.skipIf(storePath === undefined)('isolated runtime owner fixture', () => {
  it('refuses the second Host before Admission or Dispatch can mount', async () => {
    if (storePath === undefined) throw new Error('missing runtime owner fixture store')
    const ctx = await mountHostServices(storePath, {
      'dsh-autopilot': { runtimeStorePath: storePath },
    })
    try {
      await ctx.plugin(AutopilotConfig)
      await expect(ctx.plugin(RuntimeOwner, { authoritativeStorePath: storePath })).rejects.toBeInstanceOf(
        RuntimeStoreOwnedError,
      )
      expect(ctx.get('runtimeOwner')).toBeUndefined()
      expect(ctx.get('admission')).toBeUndefined()
      expect(ctx.get('dispatch')).toBeUndefined()
    } finally {
      await disposeContext(ctx)
    }
  })
})
