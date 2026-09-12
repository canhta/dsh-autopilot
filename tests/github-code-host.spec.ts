import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CodeHost,
  type CodeHostPublication,
  codeHostBindingId,
  codeHostProviderId,
  codeHostRepositoryId,
} from '../src/code-host.js'
import { registerGitHubCodeHostProvider } from '../src/github-code-host.js'
import { changesGitHubCodeHostBinding } from '../src/providers/github-code-host/settings.js'
import { providerTestContext, registerJsonMcpTool } from './mcp-provider-fixtures.js'

const baseHead = 'a'.repeat(40)
const localHead = 'b'.repeat(40)
const blob = 'c'.repeat(40)
const settings = {
  mcpServerName: 'github',
  repositoryOwner: 'canhta',
  repositoryName: 'dsh-autopilot',
  repositoryId: 'github:987654321',
  bindingId: 'github:canhta.dsh-autopilot',
  integrationActorId: '101',
  pageSize: 100,
  maxPagesPerTraversal: 10,
}
const publication: CodeHostPublication = {
  bindingId: codeHostBindingId(settings.bindingId),
  repositoryId: codeHostRepositoryId(settings.repositoryId),
  repository: 'canhta/dsh-autopilot',
  baseBranch: 'main',
  headBranch: 'autopilot/issue-8-run',
  baseHead,
  localHead,
  tree: [{ path: 'README.md', mode: '100644', type: 'blob', sha: blob }],
  files: [{ path: 'README.md', content: 'published\n' }],
  title: 'Publish issue 8',
  body: 'Ready for review.\n<!-- dsh-autopilot:run:run_123 -->',
  marker: '<!-- dsh-autopilot:run:run_123 -->',
}

const contexts = new Set<Context>()
const stops = new Set<() => Promise<void>>()

afterEach(async () => {
  await Promise.allSettled([...stops].map((stop) => stop()))
  stops.clear()
  await Promise.allSettled([...contexts].map((ctx) => ctx.fiber.dispose()))
  contexts.clear()
})

describe('GitHub MCP code-host provider', () => {
  it('fences only settings that can retarget durable publication work', () => {
    expect(changesGitHubCodeHostBinding(settings, { ...settings, bindingId: 'github:replacement' })).toBe(true)
    expect(changesGitHubCodeHostBinding(settings, { ...settings, pageSize: 50 })).toBe(false)
  })

  it('fails closed when a durable code-host binding changes without Admission ownership', async () => {
    const host = await providerTestContext({ 'dsh-autopilot-github-code-host': settings }, {})
    contexts.add(host.ctx)
    await host.ctx.plugin(CodeHost)
    const stop = await registerGitHubCodeHostProvider(host.ctx)
    stops.add(stop)

    await expect(
      host.ctx.settings.update('dsh-autopilot-github-code-host', { bindingId: 'github:replacement' }),
    ).rejects.toThrow(/Admission.*unavailable/i)
  })

  it('rejects rebinding a provider id while durable run history still uses it', async () => {
    const host = await providerTestContext({ 'dsh-autopilot-github-code-host': settings }, {})
    contexts.add(host.ctx)
    host.ctx.provide('admission', {
      codeHostSwitchBlocker: () => undefined,
      codeHostBindingSwitchBlocker: () => 'durable run history still uses this binding',
    } as unknown as Context['admission'])
    await host.ctx.plugin(CodeHost)
    const stop = await registerGitHubCodeHostProvider(host.ctx)
    stops.add(stop)

    await expect(
      host.ctx.settings.update('dsh-autopilot-github-code-host', { bindingId: 'github:replacement' }),
    ).rejects.toThrow(/durable run history/)
  })

  it('loads independently and reconciles deterministic branch and PR identity around every mutation', async () => {
    const host = await providerTestContext({ 'dsh-autopilot-github-code-host': settings }, {})
    contexts.add(host.ctx)
    await host.ctx.plugin(CodeHost)
    let remoteHead: string | undefined
    let pullRequestCreated = false
    let pullRequestState: 'open' | 'merged' = 'open'
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
    const tool = (
      name: string,
      required: readonly string[],
      execute: (args: Record<string, unknown>) => unknown,
      properties: Record<string, unknown> = {},
    ) =>
      registerJsonMcpTool(
        host.ctx,
        'github',
        name,
        required,
        (args) => {
          calls.push({ tool: name, args })
          return execute(args)
        },
        properties,
      )

    tool('get_me', [], () => ({ id: 101 }))
    tool('get_commit', ['owner', 'repo', 'sha'], () => ({ sha: baseHead }), { detail: { type: 'string' } })
    tool(
      'get_repository_tree',
      ['owner', 'repo'],
      () => ({
        sha: localHead,
        truncated: false,
        tree: publication.tree,
      }),
      { tree_sha: { type: 'string' }, recursive: { type: 'boolean' } },
    )
    tool(
      'list_branches',
      ['owner', 'repo'],
      () => (remoteHead === undefined ? [] : [{ name: publication.headBranch, sha: remoteHead, protected: false }]),
      {
        page: { type: 'number' },
        perPage: { type: 'number' },
      },
    )
    tool('list_pull_requests', ['owner', 'repo'], () => (pullRequestCreated ? [pullRequest()] : []), {
      head: { type: 'string' },
      base: { type: 'string' },
      state: { type: 'string' },
      fields: { type: 'array', items: { type: 'string' } },
      page: { type: 'number' },
      perPage: { type: 'number' },
    })
    tool('pull_request_read', ['method', 'owner', 'repo', 'pullNumber'], () => pullRequest(), {
      pullNumber: { type: 'number' },
    })
    tool(
      'create_branch',
      ['owner', 'repo', 'branch'],
      () => {
        remoteHead = baseHead
        return { ref: `refs/heads/${publication.headBranch}`, object: { sha: baseHead } }
      },
      { from_branch: { type: 'string' } },
    )
    tool(
      'push_files',
      ['owner', 'repo', 'branch', 'files', 'message'],
      () => {
        remoteHead = localHead
        return { ref: `refs/heads/${publication.headBranch}`, object: { sha: localHead } }
      },
      { files: { type: 'array', items: { type: 'object' } } },
    )
    tool(
      'create_pull_request',
      ['owner', 'repo', 'title', 'head', 'base'],
      () => {
        pullRequestCreated = true
        return { number: 8, url: 'https://github.example.invalid/pulls/8' }
      },
      { body: { type: 'string' }, draft: { type: 'boolean' } },
    )

    const stop = await registerGitHubCodeHostProvider(host.ctx)
    stops.add(stop)
    expect(host.ctx.codeHost.binding(codeHostProviderId('github'))).toEqual({
      providerId: 'github',
      bindingId: settings.bindingId,
      repositoryId: settings.repositoryId,
      repository: 'canhta/dsh-autopilot',
    })
    await host.ctx.codeHost.withProvider(codeHostProviderId('github'), async (publisher) => {
      await expect(publisher.reconcile(publication)).resolves.toMatchObject({ branch: { kind: 'missing' } })
      await publisher.createBranch(publication)
      await expect(publisher.reconcile(publication)).resolves.toMatchObject({ branch: { kind: 'base' } })
      await publisher.publishChanges(publication)
      await expect(publisher.reconcile(publication)).resolves.toMatchObject({ branch: { kind: 'published' } })
      await expect(publisher.createPullRequest(publication)).resolves.toMatchObject({ number: 8, state: 'open' })
      await expect(publisher.reconcile(publication)).resolves.toMatchObject({
        branch: { kind: 'published' },
        pullRequest: { kind: 'matching', receipt: { number: 8 } },
      })
      pullRequestState = 'merged'
      await expect(publisher.reconcile(publication)).resolves.toMatchObject({
        branch: { kind: 'published' },
        pullRequest: { kind: 'matching', receipt: { number: 8, state: 'merged' } },
      })
    })

    expect(calls.some(({ tool: name }) => name === 'create_branch')).toBe(true)
    expect(calls.some(({ tool: name }) => name === 'push_files')).toBe(true)
    expect(calls.some(({ tool: name }) => name === 'create_pull_request')).toBe(true)
    expect(calls.every(({ args }) => !('token' in args) && !('authorization' in args))).toBe(true)
    expect(host.credentials.resolveCount).toBe(0)

    function pullRequest() {
      return {
        number: 8,
        body: publication.body,
        state: pullRequestState === 'open' ? 'open' : 'closed',
        draft: false,
        merged: pullRequestState === 'merged',
        html_url: 'https://github.example.invalid/pulls/8',
        head: { ref: publication.headBranch, sha: localHead },
        base: { ref: publication.baseBranch, sha: baseHead },
      }
    }
  })

  it('treats malformed mutation receipts as ambiguous and reconciles each completed effect', async () => {
    const host = await providerTestContext({ 'dsh-autopilot-github-code-host': settings }, {})
    contexts.add(host.ctx)
    await host.ctx.plugin(CodeHost)
    let remoteHead: string | undefined
    let pullRequestCreated = false
    const attempts = { branch: 0, push: 0, pullRequest: 0 }
    const tool = (
      name: string,
      required: readonly string[],
      execute: () => unknown,
      properties: Record<string, unknown> = {},
    ) => registerJsonMcpTool(host.ctx, 'github', name, required, execute, properties)

    tool('get_me', [], () => ({ id: 101 }))
    tool('get_commit', ['owner', 'repo', 'sha'], () => ({ sha: baseHead }), { detail: { type: 'string' } })
    tool(
      'get_repository_tree',
      ['owner', 'repo'],
      () => ({ sha: localHead, truncated: false, tree: publication.tree }),
      { tree_sha: { type: 'string' }, recursive: { type: 'boolean' } },
    )
    tool(
      'list_branches',
      ['owner', 'repo'],
      () => (remoteHead === undefined ? [] : [{ name: publication.headBranch, sha: remoteHead, protected: false }]),
      { page: { type: 'number' }, perPage: { type: 'number' } },
    )
    tool('list_pull_requests', ['owner', 'repo'], () => (pullRequestCreated ? [pullRequest()] : []), {
      head: { type: 'string' },
      base: { type: 'string' },
      state: { type: 'string' },
      fields: { type: 'array', items: { type: 'string' } },
      page: { type: 'number' },
      perPage: { type: 'number' },
    })
    tool('pull_request_read', ['method', 'owner', 'repo', 'pullNumber'], () => pullRequest(), {
      pullNumber: { type: 'number' },
    })
    tool(
      'create_branch',
      ['owner', 'repo', 'branch'],
      () => {
        attempts.branch += 1
        remoteHead = baseHead
        return { ref: 7 }
      },
      { from_branch: { type: 'string' } },
    )
    tool(
      'push_files',
      ['owner', 'repo', 'branch', 'files', 'message'],
      () => {
        attempts.push += 1
        remoteHead = localHead
        return { ref: 7 }
      },
      { files: { type: 'array', items: { type: 'object' } } },
    )
    tool(
      'create_pull_request',
      ['owner', 'repo', 'title', 'head', 'base'],
      () => {
        attempts.pullRequest += 1
        pullRequestCreated = true
        return { number: 'invalid' }
      },
      { body: { type: 'string' }, draft: { type: 'boolean' } },
    )

    const stop = await registerGitHubCodeHostProvider(host.ctx)
    stops.add(stop)
    await host.ctx.codeHost.withProvider(codeHostProviderId('github'), async (publisher) => {
      await expect(publisher.createBranch(publication)).rejects.toMatchObject({
        code: 'ambiguous-acknowledgement',
      })
      await expect(publisher.reconcile(publication)).resolves.toMatchObject({ branch: { kind: 'base' } })
      await expect(publisher.publishChanges(publication)).rejects.toMatchObject({
        code: 'ambiguous-acknowledgement',
      })
      await expect(publisher.reconcile(publication)).resolves.toMatchObject({ branch: { kind: 'published' } })
      await expect(publisher.createPullRequest(publication)).rejects.toMatchObject({
        code: 'ambiguous-acknowledgement',
      })
      await expect(publisher.reconcile(publication)).resolves.toMatchObject({
        pullRequest: { kind: 'matching', receipt: { number: 8 } },
      })
    })
    expect(attempts).toEqual({ branch: 1, push: 1, pullRequest: 1 })

    function pullRequest() {
      return {
        number: 8,
        body: publication.body,
        state: 'open',
        draft: false,
        merged: false,
        html_url: 'https://github.example.invalid/pulls/8',
        head: { ref: publication.headBranch, sha: localHead },
        base: { ref: publication.baseBranch, sha: baseHead },
      }
    }
  })
})
