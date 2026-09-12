import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CODE_HOST_INTERFACE_VERSION,
  CodeHost,
  type CodeHostProvider,
  CodeHostProviderError,
  type CodeHostPublication,
  codeHostBindingId,
  codeHostProviderId,
  codeHostRepositoryId,
} from '../src/code-host.js'
import { Deferred } from './dsh-fixtures.js'

const contexts = new Set<Context>()
const publication: CodeHostPublication = {
  bindingId: codeHostBindingId('fixture:binding'),
  repositoryId: codeHostRepositoryId('fixture:repository'),
  repository: 'fixture/repository',
  baseBranch: 'main',
  headBranch: 'dsh-autopilot/run_fixture',
  baseHead: 'a'.repeat(40),
  localHead: 'b'.repeat(40),
  tree: [{ path: 'file.txt', mode: '100644', type: 'blob', sha: 'c'.repeat(40) }],
  files: [{ path: 'file.txt', content: 'fixture\n' }],
  title: 'Fixture publication',
  body: 'Fixture body\n<!-- dsh-autopilot:run:fixture -->',
  marker: '<!-- dsh-autopilot:run:fixture -->',
}

afterEach(async () => {
  await Promise.allSettled([...contexts].map((ctx) => ctx.fiber.dispose()))
  contexts.clear()
})

async function boot() {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(CodeHost)
  return ctx
}

function provider(overrides: Partial<CodeHostProvider> = {}): CodeHostProvider {
  return {
    id: codeHostProviderId('fixture'),
    interfaceVersion: CODE_HOST_INTERFACE_VERSION,
    displayName: 'Fixture code host',
    configurationNamespace: 'fixture-code-host',
    capabilities: ['repository', 'branch', 'pull-request', 'reconciliation'],
    reconcile: () =>
      Promise.resolve({
        baseHead: publication.baseHead,
        branch: { kind: 'missing' },
        pullRequest: { kind: 'missing' },
      }),
    createBranch: () => Promise.resolve(),
    publishChanges: () => Promise.resolve(),
    createPullRequest: () => Promise.reject(new Error('not used')),
    ...overrides,
  }
}

describe('code-host provider registry', () => {
  it('owns one detached target binding per provider and withdraws it with the provider lifecycle', async () => {
    const ctx = await boot()
    const binding = {
      providerId: codeHostProviderId('fixture'),
      bindingId: codeHostBindingId('fixture:binding'),
      repositoryId: codeHostRepositoryId('fixture:repository'),
      repository: 'fixture/repository',
    }
    const dispose = ctx.codeHost.registerBinding(binding)

    expect(ctx.codeHost.binding(binding.providerId)).toEqual(binding)
    await dispose()
    expect(() => ctx.codeHost.binding(binding.providerId)).toThrow(/binding.*unavailable/i)
  })

  it('rejects incomplete provider generations and malformed reconciliation output', async () => {
    const ctx = await boot()
    expect(() => ctx.codeHost.register({ ...provider(), capabilities: ['repository'] })).toThrow(/missing capabilities/)
    ctx.codeHost.register(
      provider({ reconcile: () => Promise.resolve({ baseHead: 'secret', branch: {}, pullRequest: {} } as never) }),
    )

    const error = await ctx.codeHost
      .withProvider(codeHostProviderId('fixture'), (publisher) => publisher.reconcile(publication))
      .catch((reason: unknown) => reason)

    expect(error).toMatchObject({ code: 'invalid-response' })
    expect(String(error)).not.toContain('secret')
  })

  it('aborts and drains active calls before withdrawing a provider generation', async () => {
    const ctx = await boot()
    const started = new Deferred<void>()
    const stopped = new Deferred<void>()
    const dispose = ctx.codeHost.register(
      provider({
        async reconcile({ signal }) {
          started.resolve()
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
          stopped.resolve()
          return { baseHead: publication.baseHead, branch: { kind: 'missing' }, pullRequest: { kind: 'missing' } }
        },
      }),
    )
    const active = ctx.codeHost.withProvider(codeHostProviderId('fixture'), (publisher) =>
      publisher.reconcile(publication),
    )
    await started.promise

    await dispose()

    await stopped.promise
    await expect(active).rejects.toMatchObject({ code: 'provider-unavailable' })
    await expect(
      ctx.codeHost.withProvider(codeHostProviderId('fixture'), (publisher) => publisher.reconcile(publication)),
    ).rejects.toBeInstanceOf(CodeHostProviderError)
  })

  it('classifies a late mutation result from a withdrawn generation as an ambiguous acknowledgement', async () => {
    const ctx = await boot()
    const started = new Deferred<void>()
    const release = new Deferred<void>()
    const dispose = ctx.codeHost.register(
      provider({
        async createBranch() {
          started.resolve()
          await release.promise
        },
      }),
    )
    const active = ctx.codeHost.withProvider(codeHostProviderId('fixture'), (publisher) =>
      publisher.createBranch(publication),
    )
    await started.promise

    const withdrawing = dispose()
    release.resolve()
    await withdrawing

    await expect(active).rejects.toMatchObject({ code: 'ambiguous-acknowledgement' })
  })
})
