import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerJiraProvider } from '../src/jira.js'
import { Tracker, trackerProviderId } from '../src/tracker.js'
import { MemoryCredentials, MemorySettings } from './dsh-fixtures.js'

const tokenReference = 'DSH_AUTOPILOT_JIRA_TOKEN'

const jiraSettings = {
  siteUrl: 'https://example.atlassian.net',
  cloudId: '11111111-2222-3333-4444-555555555555',
  projectKey: 'AUTO',
  email: 'bot@example.com',
  integrationAccountId: 'integration-account',
  credentialRef: tokenReference,
  readyLabel: 'ready-for-agent',
  pageSize: 2,
  priorityRanks: { high: 1, low: 3 },
  doneStatusIds: ['done'],
  blockingLinkTypeIds: ['10000'],
  dependencyDirection: 'inward',
  automationAccountIds: ['bot-account'],
  trustedHumanAccountIds: ['human-account'],
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function jsonAtSize(body: unknown, byteLength: number): Response {
  const serialized = JSON.stringify(body)
  if (serialized.length > byteLength) throw new Error('fixture exceeds requested response size')
  return new Response(`${serialized}${' '.repeat(byteLength - serialized.length)}`, {
    headers: { 'content-type': 'application/json' },
  })
}

async function boot(fetchImplementation: typeof fetch, settings = jiraSettings) {
  const ctx = new Context()
  await ctx.plugin(MemorySettings, { document: { 'dsh-autopilot-jira': settings } })
  await ctx.plugin(MemoryCredentials, { [tokenReference]: 'secret-one' })
  await ctx.plugin(Tracker)
  const dispose = registerJiraProvider(ctx, fetchImplementation)
  return { ctx, dispose, credentials: ctx.credentials as MemoryCredentials }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Jira Cloud tracker adapter', () => {
  it('normalizes paginated issue context through the tracker service', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input)
      requests.push({ url, ...(init === undefined ? {} : { init }) })
      if (url.endsWith('/rest/api/3/search/jql')) {
        return json({
          issues: [
            {
              id: '10001',
              key: 'AUTO-1',
              fields: {
                summary: 'Implement Jira admission',
                priority: { id: 'high' },
                labels: ['ready-for-agent', 'customer-label'],
                issuelinks: [
                  {
                    type: { id: '10000' },
                    inwardIssue: { id: '10000', key: 'AUTO-0', fields: { status: { id: 'done' } } },
                  },
                ],
              },
            },
          ],
          nextPageToken: 'page-2',
        })
      }
      if (url.endsWith('/rest/api/3/issue/AUTO-1/comment?startAt=0&maxResults=2')) {
        return json({
          startAt: 0,
          maxResults: 2,
          total: 3,
          comments: [
            {
              id: '20001',
              author: { accountId: 'author-1' },
              updated: '2026-09-11T00:00:00.000Z',
              body: {
                type: 'doc',
                version: 1,
                content: [
                  { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Agent Brief' }] },
                  { type: 'paragraph', content: [{ type: 'text', text: 'dsh-autopilot:brief:v1' }] },
                  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Objective' }] },
                  { type: 'paragraph', content: [{ type: 'text', text: 'Ship it.' }] },
                ],
              },
            },
            {
              id: '20002',
              author: { accountId: 'author-2' },
              updated: '2026-09-11T00:01:00.000Z',
              body: 'ordinary comment',
            },
          ],
        })
      }
      if (url.endsWith('/rest/api/3/issue/AUTO-1/comment?startAt=2&maxResults=2')) {
        return json({
          startAt: 2,
          maxResults: 2,
          total: 3,
          comments: [
            {
              id: '20003',
              author: { accountId: 'author-3' },
              updated: '2026-09-11T00:02:00.000Z',
              body: 'last comment',
            },
          ],
        })
      }
      if (url.endsWith('/rest/api/3/issue/AUTO-1/changelog?startAt=0&maxResults=2')) {
        return json({
          startAt: 0,
          maxResults: 2,
          total: 2,
          values: [
            {
              id: '30000',
              created: '2026-09-10T23:00:00.000Z',
              author: { accountId: 'bot-account', accountType: 'atlassian' },
              items: [{ fieldId: 'labels', fromString: '', toString: 'ready-for-agent' }],
            },
            {
              id: '30001',
              created: '2026-09-11T00:00:00.000Z',
              author: { accountId: 'human-account', accountType: 'atlassian' },
              items: [
                {
                  fieldId: 'labels',
                  fromString: 'customer-label',
                  toString: 'customer-label ready-for-agent',
                },
              ],
            },
          ],
        })
      }
      throw new Error(`unexpected request: ${url}`)
    }
    const { ctx } = await boot(fetchImplementation)

    const page = await ctx.tracker.readCandidates(trackerProviderId('jira'))

    expect(page.nextCursor).toBe('page-2')
    expect(page.issues).toEqual([
      {
        bindingId: expect.stringMatching(/^jira:[a-f0-9]{32}$/),
        issueId: '10001',
        displayKey: 'AUTO-1',
        summary: 'Implement Jira admission',
        priorityRank: 1,
        isReady: true,
        labels: ['ready-for-agent', 'customer-label'],
        comments: [
          expect.objectContaining({ id: '20001', authorId: 'author-1' }),
          expect.objectContaining({ id: '20002', authorId: 'author-2' }),
          expect.objectContaining({ id: '20003', authorId: 'author-3' }),
        ],
        dependencies: [{ issueId: '10000', displayKey: 'AUTO-0', state: 'completed' }],
        readiness: {
          kind: 'transition',
          generation: 'jira:30001',
          actorId: 'human-account',
          actorKind: 'human',
          occurredAt: '2026-09-11T00:00:00.000Z',
        },
      },
    ])
    expect(page.issues[0]?.comments[0]?.body).toBe('# Agent Brief\ndsh-autopilot:brief:v1\n## Objective\nShip it.\n')
    expect(requests[0]?.init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        authorization: `Basic ${Buffer.from('bot@example.com:secret-one').toString('base64')}`,
      }),
    })
  })

  it('resolves rotated credentials for every provider operation', async () => {
    const authorization: string[] = []
    const fetchImplementation: typeof fetch = async (_input, init) => {
      authorization.push(new Headers(init?.headers).get('authorization') ?? '')
      return json({ issues: [] })
    }
    const { ctx, credentials } = await boot(fetchImplementation)

    await ctx.tracker.readCandidates(trackerProviderId('jira'))
    credentials.values.set(tokenReference, 'secret-two')
    await ctx.tracker.readCandidates(trackerProviderId('jira'))

    expect(credentials.resolveCount).toBe(2)
    expect(authorization).toEqual([
      `Basic ${Buffer.from('bot@example.com:secret-one').toString('base64')}`,
      `Basic ${Buffer.from('bot@example.com:secret-two').toString('base64')}`,
    ])
  })

  it('withdraws and remounts without retaining a duplicate provider', async () => {
    const fetchImplementation: typeof fetch = async () => json({ issues: [] })
    const ctx = new Context()
    await ctx.plugin(MemorySettings, { document: { 'dsh-autopilot-jira': jiraSettings } })
    await ctx.plugin(MemoryCredentials, { [tokenReference]: 'secret-one' })
    await ctx.plugin(Tracker)
    const provider = {
      inject: ['tracker', 'settings', 'credentials'],
      apply(providerContext: Context) {
        providerContext.effect(() => registerJiraProvider(providerContext, fetchImplementation))
      },
    }
    const first = await ctx.plugin(provider)

    await first.dispose()
    await expect(ctx.tracker.readCandidates(trackerProviderId('jira'))).rejects.toMatchObject({
      code: 'provider-unavailable',
    })
    const remounted = await ctx.plugin(provider)
    await expect(ctx.tracker.readCandidates(trackerProviderId('jira'))).resolves.toEqual({ issues: [] })
    await remounted.dispose()
  })

  it('classifies rate limits without exposing credentials or response bodies', async () => {
    const fetchImplementation: typeof fetch = async () =>
      new Response(`upstream included secret-one`, { status: 429, headers: { 'retry-after': '3' } })
    const { ctx } = await boot(fetchImplementation)

    const error = await ctx.tracker.readCandidates(trackerProviderId('jira')).catch((reason: unknown) => reason)

    expect(error).toMatchObject({ code: 'rate-limit', retryAfterMs: 3000 })
    expect(String(error)).not.toContain('secret-one')
  })

  it('rejects incomplete configuration before resolving credentials or calling Jira', async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    await ctx.plugin(MemoryCredentials, { [tokenReference]: 'secret-one' })
    await ctx.plugin(Tracker)
    registerJiraProvider(ctx, fetchImplementation)

    await expect(ctx.tracker.readCandidates(trackerProviderId('jira'))).rejects.toMatchObject({
      code: 'invalid-configuration',
    })
    expect(fetchImplementation).not.toHaveBeenCalled()
    expect((ctx.credentials as MemoryCredentials).resolveCount).toBe(0)
  })

  it('always classifies the configured integration account as automation', async () => {
    const fetchImplementation: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/rest/api/3/search/jql')) {
        return json({
          issues: [
            {
              id: '10001',
              key: 'AUTO-1',
              fields: {
                summary: 'Integration-authored readiness',
                priority: { id: 'high' },
                labels: ['ready-for-agent'],
                issuelinks: [],
              },
            },
          ],
        })
      }
      if (url.includes('/comment?')) return json({ startAt: 0, maxResults: 2, total: 0, comments: [] })
      if (url.includes('/changelog?')) {
        return json({
          startAt: 0,
          maxResults: 2,
          total: 1,
          values: [
            {
              id: '30001',
              created: '2026-09-11T00:00:00.000Z',
              author: { accountId: 'integration-account', accountType: 'atlassian' },
              items: [{ fieldId: 'labels', fromString: '', toString: 'ready-for-agent' }],
            },
          ],
        })
      }
      throw new Error(`unexpected request: ${url}`)
    }
    const { ctx } = await boot(fetchImplementation)

    const page = await ctx.tracker.readCandidates(trackerProviderId('jira'))

    expect(page.issues[0]?.readiness).toMatchObject({ actorKind: 'automation' })
  })

  it('does not trust an unlisted Atlassian actor when the integration account id is mistyped', async () => {
    const fetchImplementation: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/rest/api/3/search/jql')) {
        return json({
          issues: [
            {
              id: '10001',
              key: 'AUTO-1',
              fields: {
                summary: 'Unlisted actor',
                priority: { id: 'high' },
                labels: ['ready-for-agent'],
                issuelinks: [],
              },
            },
          ],
        })
      }
      if (url.includes('/comment?')) return json({ startAt: 0, maxResults: 2, total: 0, comments: [] })
      if (url.includes('/changelog?')) {
        return json({
          startAt: 0,
          maxResults: 2,
          total: 1,
          values: [
            {
              id: '30001',
              created: '2026-09-11T00:00:00.000Z',
              author: { accountId: 'integration-account', accountType: 'atlassian' },
              items: [{ fieldId: 'labels', fromString: '', toString: 'ready-for-agent' }],
            },
          ],
        })
      }
      throw new Error('unexpected unlisted-actor request')
    }
    const { ctx } = await boot(fetchImplementation, {
      ...jiraSettings,
      integrationAccountId: 'mistyped-integration-account',
    })

    const page = await ctx.tracker.readCandidates(trackerProviderId('jira'))

    expect(page.issues[0]?.readiness).toMatchObject({ actorKind: 'unknown' })
  })

  it('fails closed when equal-time readiness transitions have ambiguous order', async () => {
    const fetchImplementation: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/rest/api/3/search/jql')) {
        return json({
          issues: [
            {
              id: '10001',
              key: 'AUTO-1',
              fields: {
                summary: 'Ambiguous readiness order',
                priority: { id: 'high' },
                labels: ['ready-for-agent'],
                issuelinks: [],
              },
            },
          ],
        })
      }
      if (url.includes('/comment?')) return json({ startAt: 0, maxResults: 2, total: 0, comments: [] })
      if (url.includes('/changelog?')) {
        return json({
          startAt: 0,
          maxResults: 2,
          total: 2,
          values: [
            {
              id: '9999',
              created: '2026-09-11T00:00:00.000Z',
              author: { accountId: 'human-account', accountType: 'atlassian' },
              items: [{ fieldId: 'labels', fromString: '', toString: 'ready-for-agent' }],
            },
            {
              id: '10000',
              created: '2026-09-11T00:00:00.000Z',
              author: { accountId: 'integration-account', accountType: 'atlassian' },
              items: [{ fieldId: 'labels', fromString: '', toString: 'ready-for-agent' }],
            },
          ],
        })
      }
      throw new Error('unexpected ambiguous-readiness request')
    }
    const { ctx } = await boot(fetchImplementation)

    await expect(ctx.tracker.readCandidates(trackerProviderId('jira'))).rejects.toMatchObject({ code: 'conflict' })
  })

  it('requires an explicit blocking-link mapping before reading Jira', async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
    const ctx = new Context()
    await ctx.plugin(MemorySettings, {
      document: {
        'dsh-autopilot-jira': { ...jiraSettings, blockingLinkTypeIds: [] },
      },
    })
    await ctx.plugin(MemoryCredentials, { [tokenReference]: 'secret-one' })
    await ctx.plugin(Tracker)
    registerJiraProvider(ctx, fetchImplementation)

    await expect(ctx.tracker.readCandidates(trackerProviderId('jira'))).rejects.toMatchObject({
      code: 'invalid-configuration',
    })
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it('requires an explicit completed-status mapping before reading Jira', async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
    const ctx = new Context()
    await ctx.plugin(MemorySettings, {
      document: {
        'dsh-autopilot-jira': { ...jiraSettings, doneStatusIds: [] },
      },
    })
    await ctx.plugin(MemoryCredentials, { [tokenReference]: 'secret-one' })
    await ctx.plugin(Tracker)
    registerJiraProvider(ctx, fetchImplementation)

    await expect(ctx.tracker.readCandidates(trackerProviderId('jira'))).rejects.toMatchObject({
      code: 'invalid-configuration',
    })
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it('requires a disjoint trusted-human mapping before reading Jira', async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
    const ctx = new Context()
    await ctx.plugin(MemorySettings, {
      document: {
        'dsh-autopilot-jira': {
          ...jiraSettings,
          trustedHumanAccountIds: ['integration-account'],
        },
      },
    })
    await ctx.plugin(MemoryCredentials, { [tokenReference]: 'secret-one' })
    await ctx.plugin(Tracker)
    registerJiraProvider(ctx, fetchImplementation)

    await expect(ctx.tracker.readCandidates(trackerProviderId('jira'))).rejects.toMatchObject({
      code: 'invalid-configuration',
    })
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it('fails closed when a configured dependency link lacks accessible issue facts', async () => {
    const fetchImplementation: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/rest/api/3/search/jql')) {
        return json({
          issues: [
            {
              id: '10001',
              key: 'AUTO-1',
              fields: {
                summary: 'Inaccessible dependency',
                priority: { id: 'high' },
                labels: ['ready-for-agent'],
                issuelinks: [{ type: { id: '10000' } }],
              },
            },
          ],
        })
      }
      if (url.includes('/comment?')) return json({ startAt: 0, maxResults: 2, total: 0, comments: [] })
      if (url.includes('/changelog?')) return json({ startAt: 0, maxResults: 2, total: 0, values: [] })
      throw new Error(`unexpected request: ${url}`)
    }
    const { ctx } = await boot(fetchImplementation)

    await expect(ctx.tracker.readCandidates(trackerProviderId('jira'))).rejects.toMatchObject({
      code: 'invalid-response',
    })
  })

  it('bounds the complete set of responses retained by one provider operation', async () => {
    const issue = (index: number) => ({
      id: `1000${String(index)}`,
      key: `AUTO-${String(index)}`,
      fields: {
        summary: `Large issue ${String(index)}`,
        priority: { id: 'high' },
        labels: ['ready-for-agent'],
        issuelinks: [],
      },
    })
    const fetchImplementation: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/rest/api/3/search/jql')) {
        return json({ issues: Array.from({ length: 5 }, (_, index) => issue(index + 1)) })
      }
      if (url.includes('/comment?')) {
        return json({
          startAt: 0,
          maxResults: 2,
          total: 1,
          comments: [
            {
              id: 'large-comment',
              updated: '2026-09-11T00:00:00.000Z',
              body: 'x'.repeat(2_000_000),
            },
          ],
        })
      }
      if (url.includes('/changelog?')) {
        return json({ startAt: 0, maxResults: 2, total: 0, values: [] })
      }
      throw new Error(`unexpected request: ${url}`)
    }
    const { ctx } = await boot(fetchImplementation)

    await expect(ctx.tracker.readCandidates(trackerProviderId('jira'))).rejects.toMatchObject({
      code: 'invalid-response',
    })
  })

  it('accepts an operation exactly at its cumulative response bound', async () => {
    const limit = 2 * 1024 * 1024
    const comment = (id: string) => ({
      id,
      updated: '2026-09-11T00:00:00.000Z',
      body: 'ordinary comment',
    })
    const fetchImplementation: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/rest/api/3/search/jql')) {
        return jsonAtSize(
          {
            issues: [
              {
                id: '10001',
                key: 'AUTO-1',
                fields: {
                  summary: 'Exact response bound',
                  priority: { id: 'high' },
                  labels: ['ready-for-agent'],
                  issuelinks: [],
                },
              },
            ],
          },
          limit,
        )
      }
      if (url.endsWith('/comment?startAt=0&maxResults=2')) {
        return jsonAtSize({ startAt: 0, maxResults: 2, total: 3, comments: [comment('one'), comment('two')] }, limit)
      }
      if (url.endsWith('/comment?startAt=2&maxResults=2')) {
        return jsonAtSize({ startAt: 2, maxResults: 2, total: 3, comments: [comment('three')] }, limit)
      }
      if (url.endsWith('/changelog?startAt=0&maxResults=2')) {
        return jsonAtSize({ startAt: 0, maxResults: 2, total: 0, values: [] }, limit)
      }
      throw new Error('unexpected exact-bound request')
    }
    const { ctx } = await boot(fetchImplementation)

    const page = await ctx.tracker.readCandidates(trackerProviderId('jira'))

    expect(page.issues[0]?.comments).toHaveLength(3)
  })
})
