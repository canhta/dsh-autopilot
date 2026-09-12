import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Tracker } from '../src/tracker.js'
import { MemoryCredentials, MemorySettings } from './dsh-fixtures.js'

export interface ProviderTestContext {
  ctx: Context
  credentials: MemoryCredentials
}

export async function providerTestContext(
  settings: Record<string, unknown>,
  credentials: Record<string, string>,
): Promise<ProviderTestContext> {
  const ctx = new Context()
  await ctx.plugin(MemorySettings, { document: settings })
  await ctx.plugin(MemoryCredentials, credentials)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Tracker)
  return { ctx, credentials: ctx.credentials as MemoryCredentials }
}

export function registerJsonMcpTool(
  ctx: Context,
  serverName: string,
  rawName: string,
  required: readonly string[],
  execute: (args: Record<string, unknown>, exec: ToolRunContext) => unknown | Promise<unknown>,
  properties: Record<string, unknown> = {},
): () => void {
  return ctx.tools.register({
    name: `mcp__${serverName}__${rawName}`,
    description: `Fixture ${rawName}`,
    parameters: {
      type: 'object',
      properties: { ...Object.fromEntries(required.map((name) => [name, { type: 'string' }])), ...properties },
      required: [...required],
      additionalProperties: true,
    },
    output: {
      schema: {
        type: 'object',
        properties: { content: { type: 'array', items: {} } },
        required: ['content'],
        additionalProperties: false,
      },
      render: () => [],
    },
    async execute(args, exec) {
      const value = await execute(args as Record<string, unknown>, exec)
      return { content: [{ type: 'text', text: JSON.stringify(value) }] }
    },
  })
}
