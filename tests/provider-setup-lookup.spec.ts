import { describe, expect, it } from 'vitest'
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
