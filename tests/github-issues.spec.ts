import { createHmac } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { registerGitHubIssuesProvider } from '../src/github-issues.js'
import { trackerProviderId } from '../src/tracker.js'
import { providerTestContext, registerJsonMcpTool } from './mcp-provider-fixtures.js'

const webhookSecretRef = 'DSH_AUTOPILOT_GITHUB_ISSUES_WEBHOOK_SECRET'
const githubSettings = {
  mcpServerName: 'github',
  repositoryOwner: 'canhta',
  repositoryName: 'dsh-autopilot',
  repositoryId: '987654321',
  integrationActorId: '101',
  webhookSecretRef,
  readyLabel: 'ready-for-agent',
  pageSize: 2,
  maxPagesPerTraversal: 10,
  maxItemsPerTraversal: 100,
  priorityLabelRanks: { urgent: 1 },
  defaultPriorityRank: 4,
  completedStateReasons: ['completed'],
  automationActorIds: ['102'],
  trustedHumanActorIds: ['201'],
}

const contexts = new Set<Context>()
const stops = new Set<() => Promise<void>>()

afterEach(async () => {
  await Promise.allSettled([...stops].map((stop) => stop()))
  stops.clear()
  await Promise.allSettled([...contexts].map((ctx) => ctx.fiber.dispose()))
  contexts.clear()
})

async function boot(withTimeline = true, identityId = 101, completeFieldsEnum = true) {
  const host = await providerTestContext(
    { 'dsh-autopilot-github-issues': githubSettings },
    { [webhookSecretRef]: 'webhook-secret' },
  )
  contexts.add(host.ctx)
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  registerJsonMcpTool(host.ctx, 'github', 'get_me', [], (args) => {
    calls.push({ tool: 'get_me', args })
    return { id: identityId }
  })
  registerJsonMcpTool(
    host.ctx,
    'github',
    'list_issues',
    ['owner', 'repo'],
    (args) => {
      calls.push({ tool: 'list_issues', args })
      return {
        issues: [
          {
            number: 7,
            title: 'Use official MCP',
            state: 'OPEN',
            labels: ['ready-for-agent', 'urgent'],
            created_at: '2026-09-11T00:00:00.000Z',
          },
        ],
        totalCount: 1,
        pageInfo: { hasNextPage: false },
      }
    },
    {
      ...mcpProperties('labels', 'fields', 'perPage', 'after'),
      fields: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['number', 'title', 'state', 'labels', ...(completeFieldsEnum ? ['created_at'] : [])],
        },
      },
      state: { type: 'string', enum: ['OPEN', 'CLOSED'] },
      orderBy: { type: 'string', enum: ['CREATED_AT', 'UPDATED_AT'] },
      direction: { type: 'string', enum: ['ASC', 'DESC'] },
    },
  )
  registerJsonMcpTool(
    host.ctx,
    'github',
    'issue_read',
    ['method', 'owner', 'repo', 'issue_number'],
    (args) => {
      calls.push({ tool: 'issue_read', args })
      if (args.method === 'get_comments') {
        return [
          {
            id: 8001,
            user: { id: 201 },
            body: '# Agent Brief\ndsh-autopilot:brief:v1\n## Objective\nShip it.\n',
            updated_at: '2026-09-11T00:01:00.000Z',
          },
        ]
      }
      return { number: 6, state: 'closed', state_reason: 'completed' }
    },
    {
      ...mcpProperties('issue_number', 'page', 'perPage'),
      method: { type: 'string', enum: ['get', 'get_comments'] },
    },
  )
  registerJsonMcpTool(
    host.ctx,
    'github',
    'issue_dependency_read',
    ['method', 'owner', 'repo', 'issue_number'],
    (args) => {
      calls.push({ tool: 'issue_dependency_read', args })
      return {
        issues: [{ number: 6, state: 'CLOSED', repository: 'canhta/dsh-autopilot' }],
        pageInfo: { hasNextPage: false, nextPage: 0 },
      }
    },
    {
      ...mcpProperties('issue_number', 'page', 'perPage'),
      method: { type: 'string', enum: ['get_blocked_by'] },
    },
  )
  if (withTimeline) {
    registerJsonMcpTool(
      host.ctx,
      'github',
      'autopilot_read_issue_timeline',
      ['owner', 'repo', 'issue_number'],
      (args) => {
        calls.push({ tool: 'autopilot_read_issue_timeline', args })
        return {
          events: [
            {
              id: 9001,
              event: 'labeled',
              created_at: '2026-09-11T00:02:00.000Z',
              actor: { id: 201, type: 'User' },
              label: { name: 'ready-for-agent' },
              repository_id: 987654321,
            },
          ],
          pageInfo: { hasNextPage: false },
        }
      },
      mcpProperties('issue_number', 'page', 'perPage'),
    )
  }
  const stop = await registerGitHubIssuesProvider(host.ctx)
  stops.add(stop)
  return { ...host, calls }
}

function mcpProperties(...names: string[]): Record<string, unknown> {
  const arrayNames = new Set(['labels', 'fields'])
  const numberNames = new Set(['issue_number', 'page', 'perPage'])
  return Object.fromEntries(
    names.map((name) => [
      name,
      arrayNames.has(name)
        ? { type: 'array', items: { type: 'string' } }
        : { type: numberNames.has(name) ? 'number' : 'string' },
    ]),
  )
}

describe('GitHub Issues MCP tracker provider', () => {
  it('builds complete admission evidence through exact MCP tools without outbound credentials', async () => {
    const { ctx, credentials, calls } = await boot()

    const page = await ctx.tracker.readCandidates(trackerProviderId('github-issues'))

    expect(page).toMatchObject({
      issues: [
        {
          issueId: '7',
          displayKey: 'canhta/dsh-autopilot#7',
          priorityRank: 1,
          comments: [{ id: '8001', authorId: '201' }],
          dependencies: [{ displayKey: 'canhta/dsh-autopilot#6', state: 'completed' }],
          readiness: { generation: 'github-issues:9001', actorKind: 'human' },
        },
      ],
    })
    expect(calls.map(({ tool }) => tool)).toEqual([
      'get_me',
      'list_issues',
      'issue_read',
      'autopilot_read_issue_timeline',
      'issue_dependency_read',
      'issue_read',
    ])
    expect(calls.every(({ args }) => !('token' in args) && !('authorization' in args))).toBe(true)
    expect(credentials.resolveCount).toBe(0)
  })

  it('stays unavailable when the same-auth readiness-history capability is missing', async () => {
    const { ctx } = await boot(false)

    await expect(ctx.tracker.readCandidates(trackerProviderId('github-issues'))).rejects.toMatchObject({
      code: 'provider-unavailable',
    })
  })

  it('rejects an MCP identity that does not match the configured automation actor', async () => {
    const { ctx } = await boot(true, 201)

    await expect(ctx.tracker.readCandidates(trackerProviderId('github-issues'))).rejects.toMatchObject({
      code: 'provider-unavailable',
    })
  })

  it('stays unavailable when the official issue field contract drifts', async () => {
    const { ctx } = await boot(true, 101, false)

    await expect(ctx.tracker.readCandidates(trackerProviderId('github-issues'))).rejects.toMatchObject({
      code: 'provider-unavailable',
    })
  })

  it('keeps inbound webhook authentication separate from MCP outbound auth', async () => {
    const { ctx, credentials } = await boot()
    const body = new TextEncoder().encode(JSON.stringify({ action: 'labeled', repository: { id: 987654321 } }))
    const signature = createHmac('sha256', 'webhook-secret').update(body).digest('hex')

    await expect(
      ctx.tracker.withProvider(trackerProviderId('github-issues'), (reader) =>
        reader.verifyIngress({
          method: 'POST',
          headers: [
            { name: 'content-type', value: 'application/json' },
            { name: 'x-github-event', value: 'issues' },
            { name: 'x-github-delivery', value: '018f3e6b-7c2d-7abc-8def-0123456789ab' },
            { name: 'x-hub-signature-256', value: `sha256=${signature}` },
          ],
          body,
        }),
      ),
    ).resolves.toMatchObject({ deliveryId: expect.stringMatching(/^github-issues:/) })
    expect(credentials.resolveCount).toBe(1)
  })
})
