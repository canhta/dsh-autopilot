import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { TrackerProvider } from '../tracker.js'
import { TrackerProviderError } from '../tracker.js'
import type { McpContractMap } from './contracts.js'
import { type McpTools, type ResolvedMcpTools, resolveMcpTools } from './read-tools.js'

interface RequiredMcpToolset<Contracts extends McpContractMap> {
  readonly serverName: string
  readonly contracts: Contracts
}

export interface McpTrackerMountOptions<Settings, Contracts extends McpContractMap> {
  readonly settings: SettingsScope<Settings>
  requiredToolset(settings: Readonly<Settings>): RequiredMcpToolset<Contracts>
  createProvider(settings: Readonly<Settings>, tools: McpTools<Contracts>): TrackerProvider
}

interface ActiveGeneration<Settings, Contracts extends McpContractMap> {
  readonly settings: Readonly<Settings>
  readonly resolved: ResolvedMcpTools<Contracts>
  readonly disposeProvider: () => Promise<void>
}

/** Keep one tracker generation registered exactly while its Settings snapshot and required MCP tools remain current. */
export async function mountMcpTracker<Settings, Contracts extends McpContractMap>(
  ctx: Context,
  options: McpTrackerMountOptions<Settings, Contracts>,
): Promise<() => Promise<void>> {
  let active: ActiveGeneration<Settings, Contracts> | undefined
  let revision = 0
  let stopped = false
  let queue = Promise.resolve()

  const reconcile = async (requestedRevision: number): Promise<void> => {
    if (stopped) return
    let settings: Readonly<Settings>
    let required: RequiredMcpToolset<Contracts>
    let resolved: ResolvedMcpTools<Contracts> | undefined
    try {
      settings = structuredClone(options.settings.get())
      required = options.requiredToolset(settings)
      resolved = resolveMcpTools(
        ctx,
        required.serverName,
        required.contracts,
        (code, message) => new TrackerProviderError(code, message),
      )
    } catch {
      await withdraw()
      ctx.logger.warn('autopilot MCP tracker configuration is invalid; provider remains unavailable')
      return
    }

    if (
      resolved !== undefined &&
      active !== undefined &&
      isDeepStrictEqual(active.settings, settings) &&
      active.resolved.sameDefinitions(resolved)
    ) {
      return
    }

    await withdraw()
    if (stopped || requestedRevision !== revision || resolved === undefined || !resolved.isCurrent()) return

    try {
      const provider = options.createProvider(settings, resolved.tools)
      const disposeProvider = ctx.tracker.register(provider)
      if (stopped || requestedRevision !== revision || !resolved.isCurrent()) {
        await disposeProvider()
        return
      }
      active = { settings, resolved, disposeProvider }
    } catch {
      ctx.logger.warn('autopilot MCP tracker provider could not be activated')
    }
  }

  const withdraw = async (): Promise<void> => {
    const current = active
    active = undefined
    if (current !== undefined) await current.disposeProvider()
  }

  const schedule = (): Promise<void> => {
    const requestedRevision = ++revision
    queue = queue
      .then(() => reconcile(requestedRevision))
      .catch(() => {
        ctx.logger.warn('autopilot MCP tracker reconciliation failed; provider remains unavailable')
      })
    return queue
  }

  const stopSettingsWatch = options.settings.watch(() => schedule())
  const stopToolsWatch = ctx.on('tools/change', () => {
    void schedule()
  })
  await schedule()

  return async () => {
    if (stopped) return
    stopped = true
    revision += 1
    stopSettingsWatch()
    stopToolsWatch()
    await queue
    await withdraw()
  }
}
