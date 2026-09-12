import type { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  initialMaintenanceState,
  MAINTENANCE_STATE_KEY,
  type MaintenanceState,
  maintenanceDomainSpec,
  maintenanceStateSchema,
} from './state.js'

export class MaintenanceStateStore {
  private table: KvTable<typeof MAINTENANCE_STATE_KEY, MaintenanceState> | undefined
  private closeDomain: (() => Promise<void>) | undefined
  private opening: Promise<void> | undefined
  failure: string | undefined

  constructor(private readonly ctx: Context) {}

  async open(): Promise<void> {
    if (this.table !== undefined) return
    if (this.opening !== undefined) return await this.opening
    this.opening = this.openDomain()
    try {
      await this.opening
      this.failure = undefined
    } catch (error) {
      this.failure = boundedError(error)
      throw error
    } finally {
      this.opening = undefined
    }
  }

  async close(): Promise<void> {
    await this.opening
    await this.closeDomain?.()
    this.closeDomain = undefined
    this.table = undefined
  }

  ready(): boolean {
    return this.table !== undefined
  }

  current(): MaintenanceState {
    const current = this.table?.get(MAINTENANCE_STATE_KEY)
    if (current === undefined) throw new Error('maintenance state is unavailable')
    return current
  }

  async update(mutate: (state: MaintenanceState) => MaintenanceState, shouldUpdate = true): Promise<void> {
    if (!shouldUpdate) return
    const table = this.table
    if (table === undefined) throw new Error('maintenance state is unavailable')
    try {
      await table.update(MAINTENANCE_STATE_KEY, (current) => {
        const next = mutate(structuredClone(current))
        return maintenanceStateSchema.parse({ ...next, revision: current.revision + 1 })
      })
      this.failure = undefined
    } catch (error) {
      this.failure = boundedError(error)
      throw error
    }
  }

  private async openDomain(): Promise<void> {
    await this.ctx.runtimeOwner.ensureOwned()
    const domain = await this.ctx.storageDomain.open(maintenanceDomainSpec)
    try {
      this.closeDomain = () => domain.close()
      this.table = domain.table('state')
      if (this.table.get(MAINTENANCE_STATE_KEY) === undefined) {
        await this.table.put(MAINTENANCE_STATE_KEY, initialMaintenanceState())
      }
    } catch (error) {
      this.table = undefined
      this.closeDomain = undefined
      await domain.close()
      throw error
    }
  }
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length <= 4096 ? message : message.slice(0, 4096)
}
