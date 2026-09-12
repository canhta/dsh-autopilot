import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type NotificationEvent,
  Notifications,
  notificationDestinationId,
  notificationProviderId,
} from '../src/notification.js'
import * as NtfyNotification from '../src/ntfy-notification.js'
import * as WebhookNotification from '../src/webhook-notification.js'
import { disposeContext, MemoryCredentials, mountHostServices } from './dsh-fixtures.js'

const contexts = new Set<Context>()
const directories = new Set<string>()

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.allSettled([...contexts].map(disposeContext))
  await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })))
  contexts.clear()
  directories.clear()
})

describe('loadable HTTP notification providers', () => {
  it('delivers the complete versioned event to one fixed generic webhook destination', async () => {
    const ctx = await boot({
      'dsh-autopilot-webhook-notification': {
        destinations: [
          {
            id: 'operations',
            url: 'https://hooks.example.invalid/autopilot',
            authorizationCredentialRef: 'AUTOPILOT_WEBHOOK_TOKEN',
          },
        ],
        timeoutMs: 1_000,
      },
    })
    await ctx.plugin(MemoryCredentials, { AUTOPILOT_WEBHOOK_TOKEN: 'fixture-secret' })
    await ctx.plugin(Notifications)
    const calls: Array<{ input: string; init: RequestInit | undefined }> = []
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input: String(input), init })
      return Promise.resolve(new Response(null, { status: 204, headers: { 'x-request-id': 'request-42' } }))
    })
    await ctx.plugin(WebhookNotification)

    const receipt = await ctx.notifications.withProvider(notificationProviderId('webhook'), (sender) =>
      sender.deliver(notificationDestinationId('operations'), event()),
    )

    expect(receipt).toEqual({ receiptId: 'webhook:request-42', receivedAt: expect.any(String) })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      input: 'https://hooks.example.invalid/autopilot',
      init: {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: 'Bearer fixture-secret',
          'content-type': 'application/json',
          'idempotency-key': 'event:notification-1',
          'x-autopilot-event-id': 'event:notification-1',
        },
      },
    })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(event())
  })

  it('publishes bounded ntfy JSON and retains the provider acknowledgement', async () => {
    const ctx = await boot({
      'dsh-autopilot-ntfy-notification': {
        destinations: [
          {
            id: 'phone',
            serverUrl: 'https://ntfy.example.invalid',
            topic: 'autopilot_ops',
            tokenCredentialRef: '',
          },
        ],
        timeoutMs: 1_000,
      },
    })
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(Notifications)
    let body = ''
    vi.stubGlobal('fetch', (_input: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body)
      return Promise.resolve(
        new Response(JSON.stringify({ id: 'ntfy-message-1', time: 1_789_171_200 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    })
    await ctx.plugin(NtfyNotification)

    const receipt = await ctx.notifications.withProvider(notificationProviderId('ntfy'), (sender) =>
      sender.deliver(notificationDestinationId('phone'), event()),
    )

    expect(receipt).toEqual({ receiptId: 'ntfy:ntfy-message-1', receivedAt: '2026-09-12T00:00:00.000Z' })
    expect(JSON.parse(body)).toEqual({
      topic: 'autopilot_ops',
      title: 'FIX-8: completed',
      message: [
        'Autopilot notification v1',
        'Pull request is ready for review.',
        'Event: event:notification-1',
        'Run: run_8 https://autopilot.example.invalid/runs/run_8',
        'Issue: jira:project:8 (FIX-8) https://tracker.example.invalid/browse/FIX-8',
        'Type: completed',
        'Pull request: https://github.example.invalid/pull/8',
        'Usage: provider 42 tokens',
      ].join('\n'),
      click: 'https://github.example.invalid/pull/8',
      actions: [{ action: 'view', label: 'Open run', url: 'https://autopilot.example.invalid/runs/run_8' }],
    })
  })
})

async function boot(settings: Record<string, unknown>): Promise<Context> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-autopilot-notifications-'))
  directories.add(directory)
  const ctx = await mountHostServices(join(directory, 'state.sqlite'), settings)
  contexts.add(ctx)
  return ctx
}

function event(): NotificationEvent {
  return {
    version: 1,
    eventId: 'event:notification-1',
    runId: 'run_8',
    timestamp: '2026-09-12T00:00:00.000Z',
    type: 'completed',
    issueIdentity: 'jira:project:8',
    displayKey: 'FIX-8',
    summary: 'Pull request is ready for review.',
    runUrl: 'https://autopilot.example.invalid/runs/run_8',
    issueUrl: 'https://tracker.example.invalid/browse/FIX-8',
    pullRequestUrl: 'https://github.example.invalid/pull/8',
    usage: { kind: 'provider', tokens: 42 },
  }
}
