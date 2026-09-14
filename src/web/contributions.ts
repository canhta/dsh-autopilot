import { type Context, Service } from '@deepseek-ai/cordis'
import type { RunId } from '../admission.js'
import type { CleanupPreviewView, DeliveryView, ProviderSetupView, WorktreeView } from './contract.js'

export interface DeliveryViewContribution {
  readonly id: string
  views(runId: RunId): readonly DeliveryView[] | undefined
}

export interface WorktreeViewContribution {
  readonly id: string
  inspect(runId: RunId, signal?: AbortSignal): Promise<WorktreeView | undefined>
  preview(runId: RunId, signal?: AbortSignal): Promise<CleanupPreviewView | undefined>
}

export interface ProviderSetupContribution {
  readonly providerId: string
  readonly displayName: string
  readonly configurationNamespace: string
  view(signal?: AbortSignal): Promise<ProviderSetupView>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    autopilotWebContributions: AutopilotWebContributions
  }
}

/** Lifecycle-owned registry for optional delivery, maintenance, and provider-setup browser projections. */
export class AutopilotWebContributions extends Service {
  private readonly deliveries = new Map<string, DeliveryViewContribution>()
  private readonly worktrees = new Map<string, WorktreeViewContribution>()
  private readonly providers = new Map<string, ProviderSetupContribution>()

  constructor(ctx: Context) {
    super(ctx, 'autopilotWebContributions')
  }

  registerDelivery(contribution: DeliveryViewContribution): () => void {
    return registerUnique(this.deliveries, contribution.id, contribution)
  }

  registerWorktree(contribution: WorktreeViewContribution): () => void {
    return registerUnique(this.worktrees, contribution.id, contribution)
  }

  registerProvider(contribution: ProviderSetupContribution): () => void {
    return registerUnique(this.providers, contribution.providerId, contribution)
  }

  deliveriesFor(runId: RunId): DeliveryView[] {
    for (const contribution of this.deliveries.values()) {
      const views = contribution.views(runId)
      if (views !== undefined) return [...structuredClone(views)]
    }
    return []
  }

  async inspectWorktree(runId: RunId, signal?: AbortSignal): Promise<WorktreeView | undefined> {
    for (const contribution of this.worktrees.values()) {
      const view = await contribution.inspect(runId, signal)
      if (view !== undefined) return structuredClone(view)
    }
  }

  async previewCleanup(runId: RunId, signal?: AbortSignal): Promise<CleanupPreviewView | undefined> {
    for (const contribution of this.worktrees.values()) {
      const view = await contribution.preview(runId, signal)
      if (view !== undefined) return structuredClone(view)
    }
  }

  providerViews(): readonly ProviderSetupContribution[] {
    return [...this.providers.values()]
  }

  availability(): { deliveries: boolean; worktrees: boolean } {
    return { deliveries: this.deliveries.size > 0, worktrees: this.worktrees.size > 0 }
  }
}

function registerUnique<T>(registry: Map<string, T>, id: string, value: T): () => void {
  if (registry.has(id)) throw new Error(`Autopilot Web contribution "${id}" is already registered`)
  registry.set(id, value)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    if (registry.get(id) === value) registry.delete(id)
  }
}
