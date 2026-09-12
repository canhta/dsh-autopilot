import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AutopilotCommands } from '../src/web/commands.js'
import { AutopilotWebContributions, AutopilotWebIntegrations } from '../src/web.js'
import { bootFixture, ControlledAdapter, temporaryDirectories } from './dispatch-fixtures.js'

describe('Autopilot Web production integrations', () => {
  it('keeps durable tracker intents fenced and retries only the selected delivery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-web-delivery-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter('failed'))
    const failed = await ctx.dispatch.dispatchNext()
    if (failed?.state !== 'failed') throw new Error('fixture did not reach its failed terminal state')

    await ctx.plugin(AutopilotWebContributions)
    await ctx.plugin(AutopilotWebIntegrations)
    const pending = ctx.autopilotWebContributions
      .deliveriesFor(failed.runId)
      .filter((delivery) => delivery.status === 'pending')
    expect(pending.length).toBeGreaterThan(1)

    await expect(ctx.settings.update('dsh-autopilot', { trackerProvider: 'replacement' })).rejects.toThrow(
      /unresolved delivery intent/i,
    )

    const selected = pending[0]
    if (selected === undefined) throw new Error('fixture has no retryable delivery')
    const commands = new AutopilotCommands(ctx)
    commands.start()
    const requestId = '1c2ccbd1-3ea2-40f7-87b2-2025fe9a1429'
    await expect(
      commands.command({ requestId, kind: 'retry-delivery', deliveryId: selected.id }),
    ).resolves.toMatchObject({ status: 'accepted' })
    await vi.waitFor(() => expect(commands.status(requestId)).toMatchObject({ status: 'succeeded' }))

    const afterRetry = ctx.autopilotWebContributions.deliveriesFor(failed.runId)
    expect(afterRetry.find(({ id }) => id === selected.id)).toMatchObject({ status: 'succeeded', attempts: 1 })
    expect(afterRetry.some(({ id, status }) => id !== selected.id && status === 'pending')).toBe(true)

    await ctx.delivery.deliverPending()
    await expect(ctx.settings.update('dsh-autopilot', { trackerProvider: 'replacement' })).resolves.toBeUndefined()
    await commands.dispose()
  })

  it('reconciles a replayed retry command from an authoritative delivery receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-web-delivery-replay-'))
    temporaryDirectories.push(root)
    const ctx = await bootFixture(root, new ControlledAdapter('failed'))
    const failed = await ctx.dispatch.dispatchNext()
    const selected = failed?.deliveries.find((delivery) => delivery.status === 'pending')
    if (selected === undefined) throw new Error('fixture has no pending delivery')
    const delivered = await ctx.delivery.deliver(selected.id)
    if (delivered.status !== 'succeeded' || delivered.receiptId === undefined) {
      throw new Error('fixture delivery did not retain an authoritative receipt')
    }
    const requestId = '58e78169-0b7c-4927-a24f-e1081f011031'
    await ctx.admission.acceptOperatorCommand({ requestId, kind: 'retry-delivery', deliveryId: selected.id })
    await ctx.admission.updateOperatorCommand(requestId, { status: 'in-progress' })

    const commands = new AutopilotCommands(ctx)
    commands.start()

    await vi.waitFor(() => expect(commands.status(requestId)).toMatchObject({ status: 'succeeded' }))
    expect(
      ctx.admission
        .snapshot()
        .runs.flatMap((run) => run.deliveries)
        .find((delivery) => delivery.id === selected.id),
    ).toMatchObject({ status: 'succeeded', attempts: delivered.attempts, receiptId: delivered.receiptId })
    await commands.dispose()
  })
})
