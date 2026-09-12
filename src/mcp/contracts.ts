import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
const RAW_TOOL_NAME = /^[A-Za-z0-9_-]+$/
const MAX_PUBLIC_TOOL_NAME_LENGTH = 64

/** Canonical value produced by DSH's MCP tool bridge. */
export interface McpResult {
  readonly content: readonly unknown[]
  readonly structuredContent?: unknown
}

/** One closed semantic operation backed by a version-pinned MCP tool contract. */
export interface McpContract<Input, Output> {
  readonly rawName: string
  readonly maxResultBytes: number
  acceptsDefinition(definition: ToolDefinition): boolean
  encode(input: Input): unknown
  decode(result: McpResult): Output
}

export type McpContractMap = Readonly<Record<string, McpContract<unknown, unknown>>>

export type McpContractInput<Contract> = Contract extends McpContract<infer Input, unknown> ? Input : never
export type McpContractOutput<Contract> = Contract extends McpContract<unknown, infer Output> ? Output : never

/** Preserve a provider's closed semantic-operation keys while validating its static contract declarations. */
export function defineMcpContracts<const Contracts extends McpContractMap>(contracts: Contracts): Contracts {
  if (Object.keys(contracts).length === 0) throw new TypeError('MCP read contracts must not be empty')
  for (const [operation, contract] of Object.entries(contracts)) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(operation)) {
      throw new TypeError('MCP semantic operation names must be alphanumeric identifiers')
    }
    if (!RAW_TOOL_NAME.test(contract.rawName)) {
      throw new TypeError(`MCP operation "${operation}" has an invalid raw tool name`)
    }
    if (!Number.isSafeInteger(contract.maxResultBytes) || contract.maxResultBytes < 1) {
      throw new TypeError(`MCP operation "${operation}" must declare a positive result-byte bound`)
    }
  }
  return contracts
}

/** Resolve only names that DSH publishes verbatim, avoiding a duplicate of its lossy name-normalization algorithm. */
export function exactMcpToolName(serverName: string, rawName: string): string {
  if (!SERVER_NAME.test(serverName)) throw new TypeError('MCP server name is invalid')
  if (!RAW_TOOL_NAME.test(rawName)) throw new TypeError('MCP raw tool name is invalid')
  const name = `mcp__${serverName}__${rawName}`
  if (name.length > MAX_PUBLIC_TOOL_NAME_LENGTH) {
    throw new TypeError('MCP tool name requires unsupported lossy normalization')
  }
  return name
}
