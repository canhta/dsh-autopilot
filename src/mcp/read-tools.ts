import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { TrackerProviderError } from '../tracker.js'
import {
  exactMcpToolName,
  type McpContractInput,
  type McpContractOutput,
  type McpReadContractMap,
  type McpResult,
} from './contracts.js'

const mcpResultSchema = z
  .object({
    content: z.array(z.unknown()),
    structuredContent: z.unknown().optional(),
  })
  .strict()

interface BoundContract {
  readonly definition: ToolDefinition
  readonly publicName: string
}

const boundDefinitions: unique symbol = Symbol('autopilot.mcp.bound-definitions')

/** A generation-fenced view that exposes only the provider's declared semantic read operations. */
export interface McpReadTools<Contracts extends McpReadContractMap> {
  call<Operation extends keyof Contracts>(
    operation: Operation,
    input: McpContractInput<Contracts[Operation]>,
    signal: AbortSignal,
  ): Promise<McpContractOutput<Contracts[Operation]>>
}

export interface ResolvedMcpReadTools<Contracts extends McpReadContractMap> {
  readonly tools: McpReadTools<Contracts>
  readonly [boundDefinitions]: ReadonlyMap<keyof Contracts, BoundContract>
  isCurrent(): boolean
  sameDefinitions(other: ResolvedMcpReadTools<Contracts>): boolean
}

/** Bind compatible live DSH tool definitions, or return undefined while the required MCP generation is unavailable. */
export function resolveMcpReadTools<Contracts extends McpReadContractMap>(
  ctx: Context,
  serverName: string,
  contracts: Contracts,
): ResolvedMcpReadTools<Contracts> | undefined {
  const bound = new Map<keyof Contracts, BoundContract>()
  try {
    for (const operation of Object.keys(contracts) as Array<keyof Contracts>) {
      const contract = contracts[operation]
      if (contract === undefined) return undefined
      const publicName = exactMcpToolName(serverName, contract.rawName)
      const definition = ctx.tools.get(publicName)
      if (definition === undefined || !acceptsDefinition(contract, definition)) return undefined
      bound.set(operation, { definition, publicName })
    }
  } catch {
    return undefined
  }

  const isCurrent = (): boolean => {
    for (const entry of bound.values()) {
      if (ctx.tools.get(entry.publicName) !== entry.definition) return false
    }
    return true
  }

  const tools: McpReadTools<Contracts> = {
    async call(operation, input, signal) {
      signal.throwIfAborted()
      const contract = contracts[operation]
      const entry = bound.get(operation)
      if (contract === undefined || entry === undefined) {
        throw new TrackerProviderError('invalid-configuration', 'MCP tracker operation is not declared')
      }
      if (ctx.tools.get(entry.publicName) !== entry.definition) throw unavailable()

      let args: unknown
      try {
        args = contract.encode(input)
      } catch {
        throw new TrackerProviderError('invalid-configuration', 'MCP tracker operation input is invalid')
      }

      const result = await ctx.tools.execute({
        callId: ToolCallId(`autopilot-${crypto.randomUUID()}`),
        name: entry.publicName,
        arguments: args,
        signal,
      })
      signal.throwIfAborted()
      if (ctx.tools.get(entry.publicName) !== entry.definition) throw unavailable()
      if (result.isError) throw mapToolFailure(result.error.info?.code)

      const parsed = parseMcpResult(result.value, contract.maxResultBytes)
      try {
        return contract.decode(parsed) as McpContractOutput<Contracts[typeof operation]>
      } catch {
        throw new TrackerProviderError('invalid-response', 'MCP tracker result did not match its contract')
      }
    },
  }

  return {
    tools,
    [boundDefinitions]: bound,
    isCurrent,
    sameDefinitions(other) {
      for (const [operation, entry] of bound) {
        if (other[boundDefinitions].get(operation)?.definition !== entry.definition) return false
      }
      return other[boundDefinitions].size === bound.size
    },
  }
}

function acceptsDefinition(contract: McpReadContractMap[string], definition: ToolDefinition): boolean {
  try {
    return contract.acceptsDefinition(definition)
  } catch {
    return false
  }
}

function parseMcpResult(value: unknown, maxResultBytes: number): McpResult {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new TrackerProviderError('invalid-response', 'MCP tracker returned an invalid result')
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > maxResultBytes) {
    throw new TrackerProviderError('invalid-response', 'MCP tracker result exceeded its safety bound')
  }
  const parsed = mcpResultSchema.safeParse(value)
  if (!parsed.success) throw new TrackerProviderError('invalid-response', 'MCP tracker returned an invalid result')
  return parsed.data
}

function mapToolFailure(code: string | undefined): TrackerProviderError {
  switch (code) {
    case 'UNKNOWN_TOOL':
      return unavailable()
    case 'TOOL_TIMEOUT':
      return new TrackerProviderError('timeout', 'MCP tracker operation timed out')
    case 'INVALID_ARGS':
      return new TrackerProviderError('invalid-configuration', 'MCP tracker operation input was rejected')
    case 'INVALID_TOOL_OUTPUT':
      return new TrackerProviderError('invalid-response', 'MCP tracker returned an invalid result')
    default:
      return new TrackerProviderError('transient', 'MCP tracker operation failed')
  }
}

function unavailable(): TrackerProviderError {
  return new TrackerProviderError('provider-unavailable', 'MCP tracker tool generation is unavailable')
}
