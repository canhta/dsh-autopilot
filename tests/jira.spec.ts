import { createHmac } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { inject as jiraInject, registerJiraProvider } from '../src/jira.js'
import { changesJiraBinding } from '../src/providers/jira/settings.js'
import { readinessGeneration, type TrackerOutboundDelivery, trackerProviderId } from '../src/tracker.js'
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
  queuedLabel: 'agent-queued',
  implementingLabel: 'agent-implementing',
  pausedLabel: 'agent-paused',
  blockedLabel: 'agent-blocked',
  failedLabel: 'agent-failed',
  completedLabel: 'agent-completed',
  reviewTransitionId: '31',
  reviewStatusId: 'review',
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
  withdrawCommentToolAfterWrite = false,
  malformedCommentReceipt = false,
  deliveredCommentAuthor = 'integration-account',
) {
  const host = await providerTestContext(
    { 'dsh-autopilot-jira': jiraSettings },
    { [webhookSecretRef]: 'webhook-secret' },
  )
  contexts.add(host.ctx)
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  let deliveredComment: { id: string; body: string } | undefined
  let currentIdentityAccountId = identityAccountId
  let writableIssueId = '10001'
  let writableProjectId = '10000'
  registerJsonMcpTool(
    host.ctx,
    'atlassian',
    'atlassianUserInfo',
    identityRequiresArgument ? ['unexpected'] : [],
    (args) => {
      calls.push({ tool: 'identity', args })
      return { account_id: currentIdentityAccountId }
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
      const comments = [
        {
          id: '20001',
          author: { accountId: 'human-account' },
          updated: '2026-09-11T00:01:00.000Z',
          body: '# Agent Brief\ndsh-autopilot:brief:v1\n## Objective\nShip it.\n',
        },
        ...(deliveredComment === undefined
          ? []
          : [
              {
                id: deliveredComment.id,
                author: { accountId: deliveredCommentAuthor },
                updated: '2026-09-11T00:04:00.000Z',
                body: deliveredComment.body,
              },
            ]),
      ]
      return {
        startAt: commentStartAt,
        maxResults: 50,
        total: comments.length,
        comments,
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
  registerJsonMcpTool(
    host.ctx,
    'atlassian',
    'getJiraIssue',
    ['cloudId', 'issueIdOrKey'],
    () => ({
      id: writableIssueId,
      key: 'AUTO-1',
      fields: {
        summary: 'Use Atlassian MCP',
        priority: { id: 'high' },
        labels: ['ready-for-agent', 'customer-label'],
        project: { id: writableProjectId },
        issuelinks: [],
        status: { id: 'todo' },
        updated: '2026-09-11T00:03:00.000Z',
      },
    }),
    mcpProperties('fields'),
  )
  let disposeCommentTool = (): void => undefined
  disposeCommentTool = registerJsonMcpTool(
    host.ctx,
    'atlassian',
    'addOrEditJiraIssueComment',
    ['cloudId', 'issueIdOrKey', 'commentBody'],
    (args) => {
      calls.push({ tool: 'addOrEditJiraIssueComment', args })
      deliveredComment = { id: '40001', body: String(args.commentBody) }
      if (withdrawCommentToolAfterWrite) disposeCommentTool()
      return malformedCommentReceipt ? { id: 40001 } : { id: '40001' }
    },
  )
  registerJsonMcpTool(
    host.ctx,
    'atlassian',
    'editJiraIssue',
    ['cloudId', 'issueIdOrKey', 'fields'],
    (args) => {
      calls.push({ tool: 'editJiraIssue', args })
      return {}
    },
    { fields: { type: 'object' } },
  )
  registerJsonMcpTool(
    host.ctx,
    'atlassian',
    'transitionJiraIssue',
    ['cloudId', 'issueIdOrKey', 'transition'],
    (args) => {
      calls.push({ tool: 'transitionJiraIssue', args })
      return {}
    },
    { transition: { type: 'object' } },
  )
  const stop = await registerJiraProvider(host.ctx)
  stops.add(stop)
  return {
    ...host,
    calls,
    setIdentityAccountId(value: string) {
      currentIdentityAccountId = value
    },
    setWritableIssueIdentity(issueId: string, projectId: string) {
      writableIssueId = issueId
      writableProjectId = projectId
    },
  }
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
  it('fences only settings that can reinterpret durable Jira work', () => {
    expect(jiraInject).not.toContain('autopilotWebContributions')
    expect(changesJiraBinding(jiraSettings, { ...jiraSettings, projectId: '10001' })).toBe(true)
    expect(changesJiraBinding(jiraSettings, { ...jiraSettings, pageSize: 25 })).toBe(false)
  })

  it('fails closed when a durable Jira binding changes without Admission ownership', async () => {
    const { ctx } = await boot()

    await expect(ctx.settings.update('dsh-autopilot-jira', { projectId: '10001' })).rejects.toThrow(
      /Admission.*unavailable/i,
    )
  })

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

  it('reconciles report markers and projects only configured labels plus the review transition', async () => {
    const { ctx, calls } = await boot()
    const issue = (await ctx.tracker.readCandidates(trackerProviderId('jira'))).issues[0]
    if (issue === undefined) throw new Error('fixture issue is missing')
    const report: TrackerOutboundDelivery = {
      kind: 'report',
      deliveryId: 'tracker:report-1',
      eventId: 'event-1',
      bindingId: issue.bindingId,
      issueId: issue.issueId,
      displayKey: issue.displayKey,
      body: 'Generated by dsh-autopilot.\n<!-- dsh-autopilot:event:event-1 -->',
    }
    const projection: TrackerOutboundDelivery = {
      kind: 'projection',
      deliveryId: 'tracker:projection-1',
      eventId: 'event-1',
      bindingId: issue.bindingId,
      issueId: issue.issueId,
      displayKey: issue.displayKey,
      readinessGeneration: readinessGeneration('jira:30001'),
      runRevision: 7,
      desiredState: 'completed',
    }

    await ctx.tracker.withWriter(trackerProviderId('jira'), async (writer) => {
      await expect(writer.reconcileDelivery(report)).resolves.toEqual({ kind: 'missing' })
      await expect(writer.deliver(report)).resolves.toMatchObject({ receiptId: 'jira:comment:40001' })
      await expect(writer.deliver(projection)).resolves.toMatchObject({
        receiptId: 'jira:projection:tracker:projection-1',
      })
    })

    const edit = calls.find(({ tool }) => tool === 'editJiraIssue')
    expect(edit?.args).toMatchObject({
      issueIdOrKey: 'AUTO-1',
      fields: { labels: ['agent-completed', 'customer-label'] },
    })
    expect(calls.find(({ tool }) => tool === 'transitionJiraIssue')?.args).toMatchObject({
      transition: { id: '31' },
    })
  })

  it('revalidates MCP identity and the durable issue target before every outbound Jira mutation', async () => {
    const fixture = await boot()
    const issue = (await fixture.ctx.tracker.readCandidates(trackerProviderId('jira'))).issues[0]
    if (issue === undefined) throw new Error('fixture issue is missing')
    const report: TrackerOutboundDelivery = {
      kind: 'report',
      deliveryId: 'tracker:bound-report',
      eventId: 'event-bound',
      bindingId: issue.bindingId,
      issueId: issue.issueId,
      displayKey: issue.displayKey,
      body: 'Generated by dsh-autopilot.\n<!-- dsh-autopilot:event:event-bound -->',
    }

    fixture.setIdentityAccountId('human-account')
    await expect(
      fixture.ctx.tracker.withWriter(trackerProviderId('jira'), (writer) => writer.deliver(report)),
    ).rejects.toMatchObject({ code: 'provider-unavailable' })

    fixture.setIdentityAccountId('integration-account')
    fixture.setWritableIssueIdentity(issue.issueId, 'different-project')
    await expect(
      fixture.ctx.tracker.withWriter(trackerProviderId('jira'), (writer) => writer.deliver(report)),
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(fixture.calls.filter(({ tool }) => tool === 'addOrEditJiraIssueComment')).toHaveLength(0)
  })

  it('rejects a recovered Jira report marker written by another account', async () => {
    const { ctx } = await boot(true, 'integration-account', 0, false, false, false, 'human-account')
    const issue = (await ctx.tracker.readCandidates(trackerProviderId('jira'))).issues[0]
    if (issue === undefined) throw new Error('fixture issue is missing')
    const report: TrackerOutboundDelivery = {
      kind: 'report',
      deliveryId: 'tracker:foreign-marker',
      eventId: 'event-foreign-marker',
      bindingId: issue.bindingId,
      issueId: issue.issueId,
      displayKey: issue.displayKey,
      body: 'Generated by dsh-autopilot.\n<!-- dsh-autopilot:event:event-foreign-marker -->',
    }

    await ctx.tracker.withWriter(trackerProviderId('jira'), (writer) => writer.deliver(report))
    await expect(
      ctx.tracker.withWriter(trackerProviderId('jira'), (writer) => writer.reconcileDelivery(report)),
    ).resolves.toMatchObject({ kind: 'conflict' })
  })

  it('treats MCP tool withdrawal after a tracker mutation as an ambiguous acknowledgement', async () => {
    const { ctx } = await boot(true, 'integration-account', 0, false, true)
    const issue = (await ctx.tracker.readCandidates(trackerProviderId('jira'))).issues[0]
    if (issue === undefined) throw new Error('fixture issue is missing')
    const report: TrackerOutboundDelivery = {
      kind: 'report',
      deliveryId: 'tracker:withdrawal-report',
      eventId: 'event-withdrawal',
      bindingId: issue.bindingId,
      issueId: issue.issueId,
      displayKey: issue.displayKey,
      body: 'Generated by dsh-autopilot.\n<!-- dsh-autopilot:event:event-withdrawal -->',
    }

    await expect(
      ctx.tracker.withWriter(trackerProviderId('jira'), (writer) => writer.deliver(report)),
    ).rejects.toMatchObject({ code: 'ambiguous-acknowledgement' })
  })

  it('reconciles a Jira comment after its successful mutation returns a malformed receipt', async () => {
    const { ctx, calls } = await boot(true, 'integration-account', 0, false, false, true)
    const issue = (await ctx.tracker.readCandidates(trackerProviderId('jira'))).issues[0]
    if (issue === undefined) throw new Error('fixture issue is missing')
    const report: TrackerOutboundDelivery = {
      kind: 'report',
      deliveryId: 'tracker:malformed-report',
      eventId: 'event-malformed',
      bindingId: issue.bindingId,
      issueId: issue.issueId,
      displayKey: issue.displayKey,
      body: 'Generated by dsh-autopilot.\n<!-- dsh-autopilot:event:event-malformed -->',
    }

    await ctx.tracker.withWriter(trackerProviderId('jira'), async (writer) => {
      await expect(writer.deliver(report)).rejects.toMatchObject({ code: 'ambiguous-acknowledgement' })
      await expect(writer.reconcileDelivery(report)).resolves.toMatchObject({
        kind: 'delivered',
        receipt: { receiptId: 'jira:comment:40001' },
      })
    })
    expect(calls.filter(({ tool }) => tool === 'addOrEditJiraIssueComment')).toHaveLength(1)
  })
})
