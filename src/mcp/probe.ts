import type { Context } from '@deepseek-ai/cordis'
import type { McpContractInput, McpContractMap } from './contracts.js'
import { resolveMcpTools } from './read-tools.js'

/** Structurally identical to `ProviderLookupView`; kept local so `mcp/` does not depend on `web/`. */
export type McpLookupProbeResult = { status: 'available' } | { status: 'unavailable'; reason: string }

/**
 * Report whether a provider's full declared MCP contract set is bound and actually reachable right now,
 * by resolving every operation exactly as `mountMcpTracker` does and issuing one live call.
 */
export async function probeMcpLookup<Contracts extends McpContractMap>(
  ctx: Context,
  serverName: string,
  contracts: Contracts,
  identityOperation: keyof Contracts,
  signal: AbortSignal,
): Promise<McpLookupProbeResult> {
  const resolved = resolveMcpTools(ctx, serverName, contracts)
  if (resolved === undefined) {
    return { status: 'unavailable', reason: `Required MCP tools are not connected under server "${serverName}".` }
  }
  try {
    await resolved.tools.call(identityOperation, {} as McpContractInput<Contracts[typeof identityOperation]>, signal)
    return { status: 'available' }
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : 'MCP lookup failed.' }
  }
}
