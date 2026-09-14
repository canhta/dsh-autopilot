import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AutopilotConfig } from '../src/config.js'
import { authoritativePathFromEntries } from '../src/operations/storage-composition.js'
import { RuntimeOwner, RuntimeStoreOwnedError } from '../src/operations.js'
import { bootFixture, ControlledAdapter, contexts, temporaryDirectories } from './dispatch-fixtures.js'
import { mountHostServices } from './dsh-fixtures.js'

describe('runtime-store ownership', () => {
  it('derives the authoritative JSON root from the active DSH Loader composition', () => {
    const root = '/var/lib/dsh/storages'
    const entry = (name: string, config: unknown) => ({
      disabled: false,
      options: { name, config },
      evaluate: (expression: string) => (expression === 'storageRoot()' ? root : undefined),
    })

    expect(
      authoritativePathFromEntries([
        entry('@deepseek-ai/dsh-storage-json', { root: { __jsExpr: 'storageRoot()' } }),
        entry('@deepseek-ai/dsh-storage-domain', { backend: 'json' }),
      ]),
    ).toBe(root)
  })

  it('prevents a separate second Host process from acquiring the same dispatch store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-owner-process-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter())
    contexts.splice(contexts.indexOf(ctx), 1)

    // Spawn Node directly against vitest's JS entry point rather than the node_modules/.bin shim:
    // the extensionless POSIX shim isn't natively executable on Windows (ENOENT), and the .CMD
    // counterpart requires shell:true, which is unnecessary risk for a fixed, literal argument list.
    const second = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        'tests/fixtures/runtime-owner-process.spec.ts',
        '--maxWorkers=1',
        '--pool=threads',
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, DSH_AUTOPILOT_OWNER_STORE: join(root, 'state.sqlite') },
        encoding: 'utf8',
        timeout: 30_000,
      },
    )
    contexts.push(ctx)

    expect(second.status).toBe(0)
    expect(second.stdout).toContain('1 passed')
    expect(ctx.runtimeOwner.snapshot()).toMatchObject({
      status: 'held',
      storePath: await realpath(join(root, 'state.sqlite')),
    })
  })

  it('rejects a symlinked owner target without touching its contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-owner-symlink-'))
    temporaryDirectories.push(root)
    const storePath = join(root, 'state.sqlite')
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'sentinel'), 'preserve\n')
    await symlink(outside, `${storePath}.autopilot-owner`)
    const ctx = await mountHostServices(storePath, { 'dsh-autopilot': { runtimeStorePath: storePath } })
    contexts.push(ctx)
    await ctx.plugin(AutopilotConfig)

    await expect(ctx.plugin(RuntimeOwner, { authoritativeStorePath: storePath })).rejects.toBeInstanceOf(
      RuntimeStoreOwnedError,
    )

    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('preserve\n')
  })

  it('locks the authoritative backend even when the editable path is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-owner-authoritative-'))
    temporaryDirectories.push(root)
    const storePath = join(root, 'actual.sqlite')
    const ctx = await mountHostServices(storePath, { 'dsh-autopilot': { runtimeStorePath: '' } })
    contexts.push(ctx)
    await ctx.plugin(AutopilotConfig)

    await ctx.plugin(RuntimeOwner, { authoritativeStorePath: storePath })

    expect(ctx.runtimeOwner.snapshot()).toMatchObject({
      status: 'held',
      storePath: join(await realpath(root), 'actual.sqlite'),
    })
  })

  it('fails before ownership when the editable path disagrees with the authoritative backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-owner-mismatch-'))
    temporaryDirectories.push(root)
    const authoritative = join(root, 'actual.sqlite')
    const declared = join(root, 'declared.sqlite')
    const ctx = await mountHostServices(authoritative, { 'dsh-autopilot': { runtimeStorePath: declared } })
    contexts.push(ctx)
    await ctx.plugin(AutopilotConfig)

    const failure = await ctx.plugin(RuntimeOwner, { authoritativeStorePath: authoritative }).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/does not match the authoritative DSH storage backend/i)
    expect(ctx.get('runtimeOwner')).toBeUndefined()
  })
})
