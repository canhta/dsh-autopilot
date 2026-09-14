import { describe, expect, it } from 'vitest'
import { CodeHost } from '../src/code-host.js'
import { registerGitHubCodeHostProvider } from '../src/github-code-host.js'
import { registerGitHubIssuesProvider } from '../src/github-issues.js'
import { registerJiraProvider } from '../src/jira.js'
import { AutopilotWebContributions } from '../src/web.js'
import { providerTestContext, registerJsonMcpTool } from './mcp-provider-fixtures.js'

function mcpProperties(...names: string[]): Record<string, unknown> {
  const arrayNames = new Set(['fields'])
  const numberNames = new Set(['maxResults', 'startAt'])
  return Object.fromEntries(
    names.map((name) => [
      name,
      arrayNames.has(name)
        ? { type: 'array', items: { type: 'string' } }
        : { type: numberNames.has(name) ? 'number' : 'string' },
    ]),
  )
}

function registerFullJiraToolset(ctx: Parameters<typeof registerJsonMcpTool>[0], onIdentity?: () => void): void {
  registerJsonMcpTool(ctx, 'atlassian', 'atlassianUserInfo', [], () => {
    onIdentity?.()
    return { account_id: 'integration-account' }
  })
  registerJsonMcpTool(
    ctx,
    'atlassian',
    'searchJiraIssuesUsingJql',
    ['cloudId', 'jql'],
    () => ({ issues: [] }),
    mcpProperties('fields', 'maxResults', 'nextPageToken'),
  )
  registerJsonMcpTool(
    ctx,
    'atlassian',
    'listJiraIssueComments',
    ['cloudId', 'issueIdOrKey'],
    () => ({ startAt: 0, maxResults: 50, total: 0, comments: [] }),
    mcpProperties('startAt', 'maxResults'),
  )
  registerJsonMcpTool(
    ctx,
    'atlassian',
    'listJiraIssueChangelogs',
    ['cloudId', 'issueIdOrKey'],
    () => ({ startAt: 0, maxResults: 50, total: 0, values: [] }),
    mcpProperties('startAt', 'maxResults'),
  )
  registerJsonMcpTool(
    ctx,
    'atlassian',
    'getJiraIssue',
    ['cloudId', 'issueIdOrKey'],
    () => ({}),
    mcpProperties('fields'),
  )
  registerJsonMcpTool(
    ctx,
    'atlassian',
    'addOrEditJiraIssueComment',
    ['cloudId', 'issueIdOrKey', 'commentBody'],
    () => ({ id: '1' }),
  )
  registerJsonMcpTool(ctx, 'atlassian', 'editJiraIssue', ['cloudId', 'issueIdOrKey', 'fields'], () => ({}), {
    fields: { type: 'object' },
  })
  registerJsonMcpTool(ctx, 'atlassian', 'transitionJiraIssue', ['cloudId', 'issueIdOrKey', 'transition'], () => ({}), {
    transition: { type: 'object' },
  })
}

describe('Jira setup-view lookup', () => {
  it('reports available once every declared Atlassian MCP tool is bound and identity resolves', async () => {
    const host = await providerTestContext({ 'dsh-autopilot-jira': {} }, {})
    await host.ctx.plugin(AutopilotWebContributions)
    registerFullJiraToolset(host.ctx)

    const unmount = await registerJiraProvider(host.ctx)
    try {
      const [contribution] = host.ctx.autopilotWebContributions.providerViews()
      const view = await contribution?.view()
      expect(view?.status).toBe('available')
      expect(view?.status === 'available' ? view.lookup : undefined).toEqual({ status: 'available' })
    } finally {
      await unmount()
      await host.ctx.fiber.dispose()
    }
  })

  it('reports unavailable with a real reason when no Atlassian MCP tools are connected', async () => {
    const host = await providerTestContext({ 'dsh-autopilot-jira': {} }, {})
    await host.ctx.plugin(AutopilotWebContributions)

    const unmount = await registerJiraProvider(host.ctx)
    try {
      const [contribution] = host.ctx.autopilotWebContributions.providerViews()
      const view = await contribution?.view()
      expect(view?.status).toBe('available')
      expect(view?.status === 'available' ? view.lookup : undefined).toEqual({
        status: 'unavailable',
        reason: 'Required MCP tools are not connected under server "atlassian".',
      })
    } finally {
      await unmount()
      await host.ctx.fiber.dispose()
    }
  })

  it('caches a successful probe instead of calling the MCP server on every view()', async () => {
    const host = await providerTestContext({ 'dsh-autopilot-jira': {} }, {})
    await host.ctx.plugin(AutopilotWebContributions)
    let identityCalls = 0
    registerFullJiraToolset(host.ctx, () => {
      identityCalls += 1
    })

    const unmount = await registerJiraProvider(host.ctx)
    try {
      const [contribution] = host.ctx.autopilotWebContributions.providerViews()
      await contribution?.view()
      await contribution?.view()
      expect(identityCalls).toBe(1)
    } finally {
      await unmount()
      await host.ctx.fiber.dispose()
    }
  })
})

describe('GitHub Issues setup-view lookup', () => {
  it('reports unavailable when the timeline/dependency extension tools are missing, even though get_me resolves', async () => {
    const host = await providerTestContext({ 'dsh-autopilot-github-issues': {} }, {})
    await host.ctx.plugin(AutopilotWebContributions)
    registerJsonMcpTool(host.ctx, 'github', 'get_me', [], () => ({ id: 1 }))
    // issue_read, list_issues, issue_dependency_read and autopilot_read_issue_timeline are intentionally
    // left unregistered: the official github-mcp-server does not expose the latter two (see docs/specs/providers.md).

    const unmount = await registerGitHubIssuesProvider(host.ctx)
    try {
      const [contribution] = host.ctx.autopilotWebContributions.providerViews()
      const view = await contribution?.view()
      expect(view?.status).toBe('available')
      expect(view?.status === 'available' ? view.lookup : undefined).toEqual({
        status: 'unavailable',
        reason: 'Required MCP tools are not connected under server "github".',
      })
    } finally {
      await unmount()
      await host.ctx.fiber.dispose()
    }
  })
})

function registerFullGitHubCodeHostToolset(
  ctx: Parameters<typeof registerJsonMcpTool>[0],
  onIdentity?: () => void,
): void {
  const tool = (
    name: string,
    required: readonly string[],
    execute: () => unknown,
    properties: Record<string, unknown> = {},
  ) => registerJsonMcpTool(ctx, 'github', name, required, execute, properties)
  tool('get_me', [], () => {
    onIdentity?.()
    return { id: 101 }
  })
  tool('get_commit', ['owner', 'repo', 'sha'], () => ({ sha: 'a'.repeat(40) }), { detail: { type: 'string' } })
  tool('get_repository_tree', ['owner', 'repo'], () => ({ sha: 'a'.repeat(40), truncated: false, tree: [] }), {
    tree_sha: { type: 'string' },
    recursive: { type: 'boolean' },
  })
  tool('list_branches', ['owner', 'repo'], () => [], { page: { type: 'number' }, perPage: { type: 'number' } })
  tool('list_pull_requests', ['owner', 'repo'], () => [], {
    head: { type: 'string' },
    base: { type: 'string' },
    state: { type: 'string' },
    fields: { type: 'array', items: { type: 'string' } },
    page: { type: 'number' },
    perPage: { type: 'number' },
  })
  tool('pull_request_read', ['method', 'owner', 'repo', 'pullNumber'], () => ({}), { pullNumber: { type: 'number' } })
  tool('create_branch', ['owner', 'repo', 'branch'], () => ({ ref: 7 }), { from_branch: { type: 'string' } })
  tool('push_files', ['owner', 'repo', 'branch', 'files', 'message'], () => ({ ref: 7 }), {
    files: { type: 'array', items: { type: 'object' } },
  })
  tool('create_pull_request', ['owner', 'repo', 'title', 'head', 'base'], () => ({ number: 1 }), {
    body: { type: 'string' },
    draft: { type: 'boolean' },
  })
}

describe('GitHub code-host setup-view lookup', () => {
  it('reports available once every declared GitHub MCP tool is bound and identity resolves', async () => {
    const host = await providerTestContext({ 'dsh-autopilot-github-code-host': {} }, {})
    await host.ctx.plugin(CodeHost)
    await host.ctx.plugin(AutopilotWebContributions)
    registerFullGitHubCodeHostToolset(host.ctx)

    const unmount = await registerGitHubCodeHostProvider(host.ctx)
    try {
      const [contribution] = host.ctx.autopilotWebContributions.codeHostProviderViews()
      const view = await contribution?.view()
      expect(view?.status).toBe('available')
      expect(view?.status === 'available' ? view.lookup : undefined).toEqual({ status: 'available' })
    } finally {
      await unmount()
      await host.ctx.fiber.dispose()
    }
  })

  it('reports unavailable with a real reason when no GitHub MCP tools are connected', async () => {
    const host = await providerTestContext({ 'dsh-autopilot-github-code-host': {} }, {})
    await host.ctx.plugin(CodeHost)
    await host.ctx.plugin(AutopilotWebContributions)

    const unmount = await registerGitHubCodeHostProvider(host.ctx)
    try {
      const [contribution] = host.ctx.autopilotWebContributions.codeHostProviderViews()
      const view = await contribution?.view()
      expect(view?.status).toBe('available')
      expect(view?.status === 'available' ? view.lookup : undefined).toEqual({
        status: 'unavailable',
        reason: 'Required MCP tools are not connected under server "github".',
      })
    } finally {
      await unmount()
      await host.ctx.fiber.dispose()
    }
  })
})
