import { createHmac } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { registerJiraProvider } from '../src/jira.js'
import { trackerProviderId } from '../src/tracker.js'
import { providerTestContext, registerJsonMcpTool } from './mcp-provider-fixtures.js'

const webhookSecretRef = 'DSH_AUTOPILOT_JIRA_WEBHOOK_SECRET'
const jiraSettings = {
  mcpServerName: 'atlassian',
  cloudId: '11111111-2222-3333-4444-555555555555',
  projectId: '10000',
  integrationAccountId: 'integration-account',
  webhookSecretRef,
  readyLabel: 'ready-for-agent',
  pageSize: 50,
  maxPagesPerTraversal: 10,
  maxItemsPerTraversal: 100,
  priorityRanks: { high: 1 },
  doneStatusIds: ['done'],
  blockingLinkTypeIds: ['10000'],
  dependencyDirection: 'inward' as const,
  automationAccountIds: ['bot-account'],
  trustedHumanAccountIds: ['human-account'],
}

const contexts = new Set<Context>()
const stops = new Set<() => Promise<void>>()

afterEach(async () => {
  await Promise.allSettled([...stops].map((stop) => stop()))
  stops.clear()
  await Promise.allSettled([...contexts].map((ctx) => ctx.fiber.dispose()))
  contexts.clear()
})

async function boot(
  withChangelog = true,
  identityAccountId = 'integration-account',
  commentStartAt = 0,
  identityRequiresArgument = false,
) {
  const host = await providerTestContext(
    { 'dsh-autopilot-jira': jiraSettings },
    { [webhookSecretRef]: 'webhook-secret' },
  )
  contexts.add(host.ctx)
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  registerJsonMcpTool(
    host.ctx,
    'atlassian',
    'atlassianUserInfo',
    identityRequiresArgument ? ['unexpected'] : [],
    (args) => {
      calls.push({ tool: 'identity', args })
      return { account_id: identityAccountId }
    },
  )
  registerJsonMcpTool(
    host.ctx,
    'atlassian',
    'searchJiraIssuesUsingJql',
    ['cloudId', 'jql'],
    (args) => {
      calls.push({ tool: 'search', args })
      return {
        issues: [
          {
            id: '10001',
            key: 'AUTO-1',
            fields: {
              summary: 'Use Atlassian MCP',
              priority: { id: 'high' },
              labels: ['ready-for-agent'],
              project: { id: '10000' },
              issuelinks: [
                {
                  type: { id: '10000' },
                  inwardIssue: { id: '10000', key: 'AUTO-0', fields: { status: { id: 'done' } } },
                },
              ],
            },
          },
        ],
      }
    },
    mcpProperties('fields', 'maxResults', 'nextPageToken'),
  )
  registerJsonMcpTool(
    host.ctx,
    'atlassian',
    'listJiraIssueComments',
    ['cloudId', 'issueIdOrKey'],
    (args) => {
      calls.push({ tool: 'comments', args })
      return {
        startAt: commentStartAt,
        maxResults: 50,
        total: 1,
        comments: [
          {
            id: '20001',
            author: { accountId: 'human-account' },
            updated: '2026-09-11T00:01:00.000Z',
            body: '# Agent Brief\ndsh-autopilot:brief:v1\n## Objective\nShip it.\n',
          },
        ],
      }
    },
    mcpProperties('startAt', 'maxResults'),
  )
  if (withChangelog) {
    registerJsonMcpTool(
      host.ctx,
      'atlassian',
      'listJiraIssueChangelogs',
      ['cloudId', 'issueIdOrKey'],
      (args) => {
        calls.push({ tool: 'changelogs', args })
        return {
          startAt: 0,
          maxResults: 50,
          total: 1,
          values: [
            {
              id: '30001',
              created: '2026-09-11T00:02:00.000Z',
              author: { accountId: 'human-account', accountType: 'atlassian' },
              items: [{ fieldId: 'labels', fromString: '', toString: 'ready-for-agent' }],
            },
          ],
        }
      },
      mcpProperties('startAt', 'maxResults'),
    )
  }
  const stop = await registerJiraProvider(host.ctx)
  stops.add(stop)
  return { ...host, calls }
}

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

describe('Jira MCP tracker provider', () => {
  it('normalizes complete admission evidence through Atlassian MCP without a second auth flow', async () => {
    const { ctx, credentials, calls } = await boot()

    const page = await ctx.tracker.readCandidates(trackerProviderId('jira'))

    expect(page).toMatchObject({
      issues: [
        {
          issueId: '10001',
          displayKey: 'AUTO-1',
          priorityRank: 1,
          comments: [{ id: '20001', authorId: 'human-account' }],
          dependencies: [{ issueId: '10000', state: 'completed' }],
          readiness: { generation: 'jira:30001', actorKind: 'human' },
        },
      ],
    })
    expect(calls.map(({ tool }) => tool)).toEqual(['identity', 'search', 'comments', 'changelogs'])
    expect(calls.every(({ args }) => !('token' in args) && !('email' in args) && !('authorization' in args))).toBe(true)
    expect(credentials.resolveCount).toBe(0)
  })

  it('requires the changelog capability instead of inferring readiness from the current label', async () => {
    const { ctx } = await boot(false)

    await expect(ctx.tracker.readCandidates(trackerProviderId('jira'))).rejects.toMatchObject({
      code: 'provider-unavailable',
    })
  })

  it('rejects an Atlassian MCP identity that does not match the integration account', async () => {
    const { ctx } = await boot(true, 'human-account')

    await expect(ctx.tracker.readCandidates(trackerProviderId('jira'))).rejects.toMatchObject({
      code: 'provider-unavailable',
    })
  })

  it('rejects a terminal evidence page whose offset does not match the request', async () => {
    const { ctx } = await boot(true, 'integration-account', 1)

    await expect(ctx.tracker.readCandidates(trackerProviderId('jira'))).rejects.toMatchObject({
      code: 'invalid-response',
    })
  })

  it('stays unavailable when the official identity tool starts requiring input', async () => {
    const { ctx } = await boot(true, 'integration-account', 0, true)

    await expect(ctx.tracker.readCandidates(trackerProviderId('jira'))).rejects.toMatchObject({
      code: 'provider-unavailable',
    })
  })

  it('uses the webhook secret only for inbound delivery authentication', async () => {
    const { ctx, credentials } = await boot()
    const body = new TextEncoder().encode('{"timestamp":1720000000000,"webhookEvent":"jira:issue_updated"}')
    const signature = createHmac('sha256', 'webhook-secret').update(body).digest('hex')

    await expect(
      ctx.tracker.withProvider(trackerProviderId('jira'), (reader) =>
        reader.verifyIngress({
          method: 'POST',
          headers: [
            { name: 'content-type', value: 'application/json' },
            { name: 'x-hub-signature', value: `sha256=${signature}` },
            { name: 'x-atlassian-webhook-identifier', value: 'delivery-123' },
          ],
          body,
        }),
      ),
    ).resolves.toMatchObject({ deliveryId: expect.stringMatching(/^jira:/) })
    expect(credentials.resolveCount).toBe(1)
  })
})
