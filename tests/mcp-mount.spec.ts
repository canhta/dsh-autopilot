import { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolRunContext } from '@deepseek-ai/dsh-tools'
import s from '@deepseek-ai/schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineMcpContracts, type McpTools, mountMcpTracker } from '../src/mcp/index.js'
import { TRACKER_INTERFACE_VERSION, Tracker, type TrackerProvider, trackerProviderId } from '../src/tracker.js'
import { MemorySettings } from './dsh-fixtures.js'

interface FixtureSettings {
  serverName: string
  project: string
}

const fixtureSettingsSchema: s<FixtureSettings> = s.object({
  serverName: s.string().default('first'),
  project: s.string().default('AUTO'),
})

const contracts = defineMcpContracts({
  listCandidates: {
    rawName: 'list_issues',
    maxResultBytes: 1_024,
    acceptsDefinition(definition) {
      const required = definition.parameters.required
      return Array.isArray(required) && required.includes('project')
    },
    encode(input: { project: string }) {
      return input
    },
    decode(result) {
      return z.object({ cursor: z.string().optional() }).parse(result.structuredContent)
    },
  },
})

const contexts = new Set<Context>()

afterEach(async () => {
  await Promise.allSettled([...contexts].map((ctx) => ctx.fiber.dispose()))
  contexts.clear()
})

async function setup(): Promise<{ ctx: Context; settings: SettingsScope<FixtureSettings>; stop: () => Promise<void> }> {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(MemorySettings, {
    document: { 'mcp-mount-fixture': { serverName: 'first', project: 'AUTO' } },
  })
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Tracker)
  const settings = ctx.settings.register('mcp-mount-fixture', fixtureSettingsSchema)
  const stop = await mountMcpTracker(ctx, {
    settings,
    requiredToolset: (current) => ({ serverName: current.serverName, contracts }),
    createProvider: (current, tools) => fixtureProvider(current, tools),
  })
  return { ctx, settings, stop }
}

function fixtureProvider(settings: Readonly<FixtureSettings>, tools: McpTools<typeof contracts>): TrackerProvider {
  return {
    id: trackerProviderId('mcp-fixture'),
    interfaceVersion: TRACKER_INTERFACE_VERSION,
    displayName: 'MCP fixture',
    configurationNamespace: 'mcp-mount-fixture',
    capabilities: ['candidates', 'comments', 'dependencies', 'readiness', 'ingress'],
    async readCandidates({ signal }) {
      const result = await tools.call('listCandidates', { project: settings.project }, signal)
      return { issues: [], ...(result.cursor === undefined ? {} : { nextCursor: result.cursor }) }
    },
    verifyIngress: () => Promise.resolve({ deliveryId: 'mcp-fixture:delivery' }),
  }
}

function registerMcpTool(
  ctx: Context,
  serverName: string,
  body: (args: unknown, exec: ToolRunContext) => Promise<unknown>,
): () => void {
  return ctx.tools.register({
    name: `mcp__${serverName}__list_issues`,
    description: 'Fixture MCP read',
    parameters: {
      type: 'object',
      properties: { project: { type: 'string' } },
      required: ['project'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { content: { type: 'array', items: {} }, structuredContent: {} },
        required: ['content'],
        additionalProperties: false,
      },
      render: () => [],
    },
    execute: body,
  })
}

async function waitForCursor(ctx: Context, cursor: string): Promise<void> {
  await vi.waitFor(async () => {
    await expect(ctx.tracker.readCandidates(trackerProviderId('mcp-fixture'))).resolves.toMatchObject({
      nextCursor: cursor,
    })
  })
}

describe('MCP tracker generation mounting', () => {
  it('registers only while every required tool is live and compatible', async () => {
    const { ctx, stop } = await setup()
    await expect(ctx.tracker.readCandidates(trackerProviderId('mcp-fixture'))).rejects.toMatchObject({
      code: 'provider-unavailable',
    })

    const disposeTool = registerMcpTool(ctx, 'first', async () => ({
      content: [],
      structuredContent: { cursor: 'first-page' },
    }))
    await waitForCursor(ctx, 'first-page')

    disposeTool()
    await vi.waitFor(async () => {
      await expect(ctx.tracker.readCandidates(trackerProviderId('mcp-fixture'))).rejects.toMatchObject({
        code: 'provider-unavailable',
      })
    })
    await stop()
  })

  it('withdraws the old generation and remounts against a changed Settings snapshot', async () => {
    const { ctx, settings, stop } = await setup()
    registerMcpTool(ctx, 'first', async () => ({ content: [], structuredContent: { cursor: 'old' } }))
    await waitForCursor(ctx, 'old')

    await settings.update({ serverName: 'second', project: 'NEXT' })
    await vi.waitFor(async () => {
      await expect(ctx.tracker.readCandidates(trackerProviderId('mcp-fixture'))).rejects.toMatchObject({
        code: 'provider-unavailable',
      })
    })

    let received: unknown
    registerMcpTool(ctx, 'second', async (args) => {
      received = args
      return { content: [], structuredContent: { cursor: 'new' } }
    })
    await waitForCursor(ctx, 'new')
    expect(received).toEqual({ project: 'NEXT' })
    await stop()
  })

  it('fences work from a removed definition before activating its replacement', async () => {
    const { ctx, stop } = await setup()
    let started: (() => void) | undefined
    let release: (() => void) | undefined
    const didStart = new Promise<void>((resolve) => {
      started = resolve
    })
    let stopAvailableWatch = () => {}
    const available = new Promise<void>((resolve) => {
      stopAvailableWatch = ctx.tracker.watchProviders((event) => {
        if (event.kind === 'available' && event.providerId === trackerProviderId('mcp-fixture')) resolve()
      })
    })
    const disposeOld = registerMcpTool(
      ctx,
      'first',
      () =>
        new Promise((resolve) => {
          started?.()
          release = () => resolve({ content: [], structuredContent: { cursor: 'stale' } })
        }),
    )
    await available
    stopAvailableWatch()
    const staleRead = ctx.tracker.readCandidates(trackerProviderId('mcp-fixture'))
    await didStart

    disposeOld()
    registerMcpTool(ctx, 'first', async () => ({ content: [], structuredContent: { cursor: 'fresh' } }))
    release?.()

    await expect(staleRead).rejects.toMatchObject({ code: 'provider-unavailable' })
    await waitForCursor(ctx, 'fresh')
    await stop()
  })
})
