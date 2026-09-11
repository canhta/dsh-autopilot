import type { z } from 'zod'
import type { McpResult } from './contracts.js'

/** Decode one machine-readable MCP result without treating prose or mixed content as data. */
export function decodeMcpJson<T>(result: McpResult, schema: z.ZodType<T>): T {
  const candidate = result.structuredContent ?? parseSingleJsonText(result.content)
  return schema.parse(candidate)
}

function parseSingleJsonText(content: readonly unknown[]): unknown {
  if (content.length !== 1) throw new TypeError('expected one MCP JSON text block')
  const [block] = content
  if (
    typeof block !== 'object' ||
    block === null ||
    !Object.hasOwn(block, 'type') ||
    !Object.hasOwn(block, 'text') ||
    (block as { type?: unknown }).type !== 'text' ||
    typeof (block as { text?: unknown }).text !== 'string'
  ) {
    throw new TypeError('expected one MCP JSON text block')
  }
  return JSON.parse((block as { text: string }).text) as unknown
}
