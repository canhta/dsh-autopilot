import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineMcpContracts, exactMcpToolName } from '../src/mcp/index.js'
import { resolveMcpTools } from '../src/mcp/read-tools.js'

const contexts = new Set<Context>()

afterEach(async () => {
  await Promise.allSettled([...contexts].map((ctx) => ctx.fiber.dispose()))
  contexts.clear()
})

interface ListInput {
  project: string
}

const listContracts = defineMcpContracts({
  listCandidates: {
    rawName: 'list_issues',
    maxResultBytes: 512,
    acceptsDefinition: acceptsProjectArgument,
    encode(input: ListInput) {
      return { project: input.project }
    },
    decode(result) {
      return z.object({ issues: z.array(z.string()) }).parse(result.structuredContent).issues
    },
  },
})

async function toolContext(): Promise<Context> {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  return ctx
}

function acceptsProjectArgument(definition: ToolDefinition): boolean {
  const required = definition.parameters.required
  return Array.isArray(required) && required.includes('project')
}

function registerMcpTool(
  ctx: Context,
  body: (args: unknown, exec: ToolRunContext) => Promise<unknown>,
  parameters: Record<string, unknown> = {
    type: 'object',
    properties: { project: { type: 'string' } },
    required: ['project'],
    additionalProperties: false,
  },
): () => void {
  return ctx.tools.register({
    name: 'mcp__fixture__list_issues',
    description: 'Fixture MCP read',
    parameters,
    output: {
      schema: {
        type: 'object',
        properties: {
          content: { type: 'array', items: {} },
          structuredContent: {},
        },
        required: ['content'],
        additionalProperties: false,
      },
      render: () => [],
    },
    execute: body,
  })
}

describe('closed MCP read tools', () => {
  it('uses the exact DSH-qualified tool name and decodes bounded structured output', async () => {
    const ctx = await toolContext()
    let received: unknown
    registerMcpTool(ctx, async (args) => {
      received = args
      return { content: [], structuredContent: { issues: ['AUTO-1'] } }
    })
    const resolved = resolveMcpTools(ctx, 'fixture', listContracts)

    await expect(
      resolved?.tools.call('listCandidates', { project: 'AUTO' }, new AbortController().signal),
    ).resolves.toEqual(['AUTO-1'])
    expect(received).toEqual({ project: 'AUTO' })
  })

  it('rejects missing or incompatible tool definitions before exposing a toolset', async () => {
    const ctx = await toolContext()
    expect(resolveMcpTools(ctx, 'fixture', listContracts)).toBeUndefined()

    registerMcpTool(ctx, async () => ({ content: [] }), {
      type: 'object',
      properties: {},
      additionalProperties: false,
    })
    expect(resolveMcpTools(ctx, 'fixture', listContracts)).toBeUndefined()
  })

  it('fences a successful result when the registered tool generation changed during the call', async () => {
    const ctx = await toolContext()
    let release: (() => void) | undefined
    const dispose = registerMcpTool(
      ctx,
      () =>
        new Promise((resolve) => {
          release = () => resolve({ content: [], structuredContent: { issues: ['stale-ticket'] } })
        }),
    )
    const resolved = resolveMcpTools(ctx, 'fixture', listContracts)
    const read = resolved?.tools.call('listCandidates', { project: 'AUTO' }, new AbortController().signal)

    dispose()
    release?.()

    await expect(read).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('bounds and validates the canonical MCP result without leaking its content', async () => {
    const ctx = await toolContext()
    registerMcpTool(ctx, async () => ({
      content: [{ type: 'text', text: 'live-ticket-secret'.repeat(40) }],
      structuredContent: { issues: [] },
    }))
    const resolved = resolveMcpTools(ctx, 'fixture', listContracts)

    const error = await resolved?.tools
      .call('listCandidates', { project: 'AUTO' }, new AbortController().signal)
      .catch((reason: unknown) => reason)
    expect(error).toMatchObject({ code: 'invalid-response' })
    expect(String(error)).not.toContain('live-ticket-secret')
  })

  it('maps tool failures to stable sanitized provider failures', async () => {
    const ctx = await toolContext()
    registerMcpTool(ctx, async () => {
      throw new Error('live-ticket-secret')
    })
    const resolved = resolveMcpTools(ctx, 'fixture', listContracts)

    const error = await resolved?.tools
      .call('listCandidates', { project: 'AUTO' }, new AbortController().signal)
      .catch((reason: unknown) => reason)
    expect(error).toMatchObject({ code: 'transient' })
    expect(String(error)).not.toContain('live-ticket-secret')
  })

  it('preserves caller cancellation instead of relabeling it', async () => {
    const ctx = await toolContext()
    registerMcpTool(
      ctx,
      (_args, exec) =>
        new Promise((_resolve, reject) => {
          exec.signal.addEventListener('abort', () => reject(exec.signal.reason), { once: true })
        }),
    )
    const resolved = resolveMcpTools(ctx, 'fixture', listContracts)
    const controller = new AbortController()
    const reason = new Error('caller stopped reconciliation')
    const read = resolved?.tools.call('listCandidates', { project: 'AUTO' }, controller.signal)

    controller.abort(reason)

    await expect(read).rejects.toBe(reason)
  })

  it('accepts only verbatim DSH MCP names', () => {
    expect(exactMcpToolName('atlassian', 'searchJiraIssuesUsingJql')).toBe('mcp__atlassian__searchJiraIssuesUsingJql')
    expect(() => exactMcpToolName('bad server', 'read')).toThrow(/server name/)
    expect(() => exactMcpToolName('fixture', 'bad/tool')).toThrow(/raw tool name/)
    expect(() => exactMcpToolName('a'.repeat(32), 'b'.repeat(32))).toThrow(/lossy normalization/)
  })
})
