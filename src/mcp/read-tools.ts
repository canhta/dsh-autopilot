import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import {
  exactMcpToolName,
  type McpContractInput,
  type McpContractMap,
  type McpContractOutput,
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

/** A generation-fenced view that exposes only the provider's declared semantic operations. */
export interface McpTools<Contracts extends McpContractMap> {
  call<Operation extends keyof Contracts>(
    operation: Operation,
    input: McpContractInput<Contracts[Operation]>,
    signal: AbortSignal,
  ): Promise<McpContractOutput<Contracts[Operation]>>
}

export interface ResolvedMcpTools<Contracts extends McpContractMap> {
  readonly tools: McpTools<Contracts>
  readonly [boundDefinitions]: ReadonlyMap<keyof Contracts, BoundContract>
  isCurrent(): boolean
  sameDefinitions(other: ResolvedMcpTools<Contracts>): boolean
}

export type McpOperationErrorCode =
  | 'authentication'
  | 'permission'
  | 'invalid-configuration'
  | 'invalid-response'
  | 'not-found'
  | 'conflict'
  | 'rate-limit'
  | 'timeout'
  | 'transient'
  | 'provider-unavailable'

export class McpOperationError extends Error {
  constructor(
    readonly code: McpOperationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'McpOperationError'
  }
}

export type McpErrorFactory = (code: McpOperationErrorCode, message: string) => Error

/** Bind compatible live DSH tool definitions, or return undefined while the required MCP generation is unavailable. */
export function resolveMcpTools<Contracts extends McpContractMap>(
  ctx: Context,
  serverName: string,
  contracts: Contracts,
  createError: McpErrorFactory = (code, message) => new McpOperationError(code, message),
): ResolvedMcpTools<Contracts> | undefined {
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

  const tools: McpTools<Contracts> = {
    async call(operation, input, signal) {
      signal.throwIfAborted()
      const contract = contracts[operation]
      const entry = bound.get(operation)
      if (contract === undefined || entry === undefined) {
        throw createError('invalid-configuration', 'MCP operation is not declared')
      }
      if (ctx.tools.get(entry.publicName) !== entry.definition) throw unavailable(createError)

      let args: unknown
      try {
        args = contract.encode(input)
      } catch {
        throw createError('invalid-configuration', 'MCP operation input is invalid')
      }

      const result = await ctx.tools.execute({
        callId: ToolCallId(`autopilot-${crypto.randomUUID()}`),
        name: entry.publicName,
        arguments: args,
        signal,
      })
      signal.throwIfAborted()
      if (ctx.tools.get(entry.publicName) !== entry.definition) throw unavailable(createError)
      if (result.isError) throw mapToolFailure(createError, result.error.info?.code)

      const parsed = parseMcpResult(result.value, contract.maxResultBytes, createError)
      try {
        return contract.decode(parsed) as McpContractOutput<Contracts[typeof operation]>
      } catch {
        throw createError('invalid-response', 'MCP result did not match its contract')
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

function acceptsDefinition(contract: McpContractMap[string], definition: ToolDefinition): boolean {
  try {
    return contract.acceptsDefinition(definition)
  } catch {
    return false
  }
}

function parseMcpResult(value: unknown, maxResultBytes: number, createError: McpErrorFactory): McpResult {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw createError('invalid-response', 'MCP returned an invalid result')
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > maxResultBytes) {
    throw createError('invalid-response', 'MCP result exceeded its safety bound')
  }
  const parsed = mcpResultSchema.safeParse(value)
  if (!parsed.success) throw createError('invalid-response', 'MCP returned an invalid result')
  return parsed.data
}

function mapToolFailure(createError: McpErrorFactory, code: string | undefined): Error {
  switch (code) {
    case 'UNKNOWN_TOOL':
      return unavailable(createError)
    case 'TOOL_TIMEOUT':
      return createError('timeout', 'MCP operation timed out')
    case 'UNAUTHENTICATED':
    case 'UNAUTHORIZED':
      return createError('authentication', 'MCP authentication failed')
    case 'FORBIDDEN':
    case 'PERMISSION_DENIED':
      return createError('permission', 'MCP operation was denied')
    case 'NOT_FOUND':
      return createError('not-found', 'MCP resource was not found')
    case 'CONFLICT':
      return createError('conflict', 'MCP resource changed concurrently')
    case 'RATE_LIMIT':
    case 'RESOURCE_EXHAUSTED':
    case 'TOO_MANY_REQUESTS':
      return createError('rate-limit', 'MCP provider rate limit was reached')
    case 'INVALID_ARGS':
      return createError('invalid-configuration', 'MCP operation input was rejected')
    case 'INVALID_TOOL_OUTPUT':
      return createError('invalid-response', 'MCP returned an invalid result')
    default:
      return createError('transient', 'MCP operation failed')
  }
}

function unavailable(createError: McpErrorFactory): Error {
  return createError('provider-unavailable', 'MCP tool generation is unavailable')
}
