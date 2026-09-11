import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { TRACKER_INGRESS_PATH } from '../src/ingress.js'
import { createFixtureTrackerProvider } from '../src/testing.js'
import { readinessGeneration, TrackerProviderError, trackerIssueId } from '../src/tracker.js'
import { candidate, createHarness, mountIngress } from './reconciliation-fixtures.js'

describe('reconciliation service seam: authenticated ingress', () => {
  it('acknowledges authenticated HTTP ingress only after durable admission', async () => {
    const { ctx } = await createHarness(
      'dsh-autopilot-ingress-',
      { 'dsh-autopilot': { trackerProvider: 'fixture' } },
      true,
    )
    let issues: (typeof candidate)[] = []
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues,
        readCandidates: () => Promise.resolve({ issues }),
        verifyIngress: ({ headers, body }) => {
          if (!headers.some((header) => header.name === 'authorization' && header.value === 'fixture-secret')) {
            throw new TrackerProviderError('authentication', 'fixture authentication failed')
          }
          if (new TextDecoder().decode(body) !== '{"event":"changed"}') {
            throw new TrackerProviderError('invalid-response', 'fixture payload was malformed')
          }
          return Promise.resolve({ deliveryId: 'fixture:delivery-1' })
        },
      }),
    )
    await mountIngress(ctx)
    await vi.waitFor(() => {
      expect(ctx.autopilotReconciliation.snapshot().lastAttempt).toMatchObject({
        source: 'startup',
        outcome: 'succeeded',
      })
    })
    issues = [candidate]

    const response = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}${TRACKER_INGRESS_PATH}`, {
      method: 'POST',
      headers: { authorization: 'fixture-secret', 'content-type': 'application/json' },
      body: '{"event":"changed"}',
    })

    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(ctx.admission.snapshot()).toMatchObject({
      acceptedIngress: ['fixture:delivery-1'],
      runs: [{ displayKey: 'FIX-1', state: 'queued' }],
    })
    expect(ctx.autopilotReconciliation.snapshot()).toMatchObject({
      active: 0,
      lastAttempt: { source: 'webhook', outcome: 'succeeded', admitted: 1 },
    })
  })

  it('handles empty and multibyte payload boundaries by UTF-8 byte length', async () => {
    const { ctx } = await createHarness(
      'dsh-autopilot-ingress-boundaries-',
      { 'dsh-autopilot': { trackerProvider: 'fixture' } },
      true,
    )
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues: [],
        verifyIngress: ({ body }) => Promise.resolve({ deliveryId: `fixture:delivery-${String(body.byteLength)}` }),
      }),
    )
    await mountIngress(ctx)
    await vi.waitFor(() => {
      expect(ctx.autopilotReconciliation.snapshot().lastAttempt).toMatchObject({
        source: 'startup',
        outcome: 'succeeded',
      })
    })
    const url = `http://127.0.0.1:${String(ctx.webServer.port)}${TRACKER_INGRESS_PATH}`

    const empty = await fetch(url, { method: 'POST' })
    const exactMultibyte = await fetch(url, { method: 'POST', body: '😀'.repeat((256 * 1024) / 4) })
    const oversizedMultibyte = await fetch(url, { method: 'POST', body: `😀${'x'.repeat(256 * 1024 - 3)}` })

    expect([empty.status, exactMultibyte.status, oversizedMultibyte.status]).toEqual([204, 204, 413])
    expect(ctx.admission.snapshot().acceptedIngress).toEqual(['fixture:delivery-0', 'fixture:delivery-262144'])
  })

  it('retries saturated HTTP ingress without consuming its delivery receipt', async () => {
    const { ctx } = await createHarness(
      'dsh-autopilot-ingress-saturation-',
      { 'dsh-autopilot': { trackerProvider: 'fixture', maxQueued: 1 } },
      true,
    )
    const secondCandidate = {
      ...candidate,
      issueId: trackerIssueId('issue-2'),
      displayKey: 'FIX-2',
      priorityRank: 2,
      readiness: { ...candidate.readiness, generation: readinessGeneration('transition-2') },
    }
    let issues: (typeof candidate)[] = [candidate]
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues,
        readCandidates: () => Promise.resolve({ issues }),
        verifyIngress: () => Promise.resolve({ deliveryId: 'fixture:capacity-delivery' }),
      }),
    )
    await mountIngress(ctx)
    await vi.waitFor(() => {
      expect(ctx.admission.snapshot().runs).toHaveLength(1)
    })
    issues = [candidate, secondCandidate]

    const response = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}${TRACKER_INGRESS_PATH}`, {
      method: 'POST',
      body: '{}',
    })

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('1')
    expect(await response.text()).toBe('webhook rejected')
    expect(ctx.admission.snapshot()).toMatchObject({
      acceptedIngress: [],
      runs: [{ displayKey: 'FIX-1', state: 'queued' }],
    })
    expect(ctx.autopilotReconciliation.snapshot().lastAttempt).toMatchObject({
      source: 'webhook',
      outcome: 'failed',
      failure: { code: 'overloaded' },
    })
  })

  it('rejects unauthenticated, malformed, and oversized ingress without mutating admission', async () => {
    const { ctx } = await createHarness(
      'dsh-autopilot-ingress-reject-',
      { 'dsh-autopilot': { trackerProvider: 'fixture' } },
      true,
    )
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues: [candidate],
        verifyIngress: ({ headers, body }) => {
          if (!headers.some((header) => header.name === 'authorization' && header.value === 'fixture-secret')) {
            throw new TrackerProviderError('authentication', 'must not expose fixture-secret')
          }
          if (new TextDecoder().decode(body) !== '{"event":"changed"}') {
            throw new TrackerProviderError('invalid-response', 'must not expose live-ticket-body')
          }
          return Promise.resolve({ deliveryId: 'fixture:delivery-1' })
        },
      }),
    )
    await mountIngress(ctx)
    await vi.waitFor(() => {
      expect(ctx.autopilotReconciliation.snapshot().lastAttempt).toMatchObject({
        source: 'startup',
        outcome: 'succeeded',
      })
    })
    const before = ctx.admission.snapshot()
    const url = `http://127.0.0.1:${String(ctx.webServer.port)}${TRACKER_INGRESS_PATH}`

    const unauthenticated = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"event":"changed"}',
    })
    expect(unauthenticated.status).toBe(401)
    expect(await unauthenticated.text()).toBe('unauthorized')
    expect(ctx.admission.snapshot()).toEqual(before)
    expect(ctx.autopilotReconciliation.snapshot().lastAttempt).toMatchObject({
      source: 'webhook',
      outcome: 'failed',
      failure: { code: 'authentication', message: 'Tracker authentication failed.' },
    })

    const malformed = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'fixture-secret', 'content-type': 'application/json' },
      body: 'live-ticket-body',
    })
    expect(malformed.status).toBe(400)
    expect(await malformed.text()).toBe('webhook rejected')
    expect(ctx.admission.snapshot()).toEqual(before)
    expect(JSON.stringify(ctx.autopilotReconciliation.snapshot())).not.toContain('fixture-secret')
    expect(JSON.stringify(ctx.autopilotReconciliation.snapshot())).not.toContain('live-ticket-body')

    const oversized = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'fixture-secret', 'content-type': 'application/json' },
      body: 'x'.repeat(256 * 1024 + 1),
    })
    expect(oversized.status).toBe(413)
    expect(ctx.admission.snapshot()).toEqual(before)
  })

  it('returns a bounded failure when the durable admission commit fails', async () => {
    const { ctx, storagePath } = await createHarness(
      'dsh-autopilot-ingress-durable-failure-',
      { 'dsh-autopilot': { trackerProvider: 'fixture' } },
      true,
    )
    let issues: (typeof candidate)[] = []
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues,
        readCandidates: () => Promise.resolve({ issues }),
        verifyIngress: () => Promise.resolve({ deliveryId: 'fixture:delivery-1' }),
      }),
    )
    await mountIngress(ctx)
    await vi.waitFor(() => {
      expect(ctx.autopilotReconciliation.snapshot().lastAttempt).toMatchObject({
        source: 'startup',
        outcome: 'succeeded',
      })
    })
    issues = [candidate]
    const database = new DatabaseSync(storagePath)
    database.exec(`CREATE TRIGGER reject_admission_update
      BEFORE UPDATE ON u_autopilot_admission_state
      BEGIN
        SELECT RAISE(ABORT, 'must not expose durable storage detail');
      END`)
    database.close()

    const response = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}${TRACKER_INGRESS_PATH}`, {
      method: 'POST',
      body: '{}',
    })

    expect(response.status).toBe(503)
    expect(await response.text()).toBe('webhook rejected')
    expect(ctx.admission.snapshot()).toMatchObject({ acceptedIngress: [], runs: [] })
    expect(ctx.autopilotReconciliation.snapshot().lastAttempt).toMatchObject({
      source: 'webhook',
      outcome: 'failed',
      failure: { code: 'internal', message: 'Reconciliation failed before it could commit.' },
    })
    expect(JSON.stringify(ctx.autopilotReconciliation.snapshot())).not.toContain('durable storage detail')
  })

  it('deduplicates concurrent ingress and reconciliation into one logical run', async () => {
    const { ctx } = await createHarness(
      'dsh-autopilot-ingress-concurrent-',
      { 'dsh-autopilot': { trackerProvider: 'fixture' } },
      true,
    )
    let issues: (typeof candidate)[] = []
    ctx.tracker.register(
      createFixtureTrackerProvider({
        issues,
        readCandidates: () => Promise.resolve({ issues }),
        verifyIngress: () => Promise.resolve({ deliveryId: 'fixture:delivery-1' }),
      }),
    )
    await mountIngress(ctx)
    await vi.waitFor(() => {
      expect(ctx.autopilotReconciliation.snapshot().lastAttempt).toMatchObject({
        source: 'startup',
        outcome: 'succeeded',
      })
    })
    issues = [candidate]
    const url = `http://127.0.0.1:${String(ctx.webServer.port)}${TRACKER_INGRESS_PATH}`

    const [first, second] = await Promise.all([
      fetch(url, { method: 'POST', body: '{}' }),
      Promise.all([fetch(url, { method: 'POST', body: '{}' }), ctx.admission.reconcile({ source: 'scheduled' })]).then(
        ([response]) => response,
      ),
    ])

    expect([first.status, second.status]).toEqual([204, 204])
    expect(ctx.admission.snapshot()).toMatchObject({
      acceptedIngress: ['fixture:delivery-1'],
      runs: [{ displayKey: 'FIX-1', state: 'queued' }],
    })
  })
})
