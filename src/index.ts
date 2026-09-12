import type { Context } from '@deepseek-ai/cordis'
import { Admission } from './admission.js'
import { CodeHost } from './code-host.js'
import { AutopilotConfig } from './config.js'
import { Delivery } from './delivery.js'
import { Dispatch } from './dispatch.js'
import { Ingress } from './ingress.js'
import { Notifications } from './notification.js'
import { AutopilotOperations, PullRequestDispositionRegistry, RuntimeOwner } from './operations.js'
import { Publication } from './publication.js'
import { Reconciliation } from './reconciliation.js'
import { Tracker } from './tracker.js'
import { AutopilotWeb, AutopilotWebContributions, AutopilotWebIntegrations } from './web.js'
import { Workflow } from './workflow.js'

export const name = 'dsh-autopilot'
export const inject = ['settings', 'storageDomain']

export interface AutopilotOptions {
  /** Programmatic Host proof when the composition does not have a DSH Loader. */
  readonly authoritativeStorePath?: string
}

export async function apply(ctx: Context, options: AutopilotOptions = {}): Promise<void> {
  await ctx.plugin(Tracker)
  await ctx.plugin(CodeHost)
  await ctx.plugin(Notifications)
  await ctx.plugin(AutopilotWebContributions)
  await ctx.plugin(AutopilotConfig)
  await ctx.plugin(RuntimeOwner, options)
  await ctx.plugin(Admission)
  await ctx.plugin(Ingress)
  await ctx.plugin(PullRequestDispositionRegistry)
  await ctx.plugin(AutopilotOperations)
  await ctx.plugin(Dispatch)
  await ctx.plugin(Publication)
  await ctx.plugin(Delivery)
  await ctx.plugin(Workflow)
  await ctx.plugin(Reconciliation)
  await ctx.plugin(AutopilotWebIntegrations)
  await ctx.plugin(AutopilotWeb)
}

export * from './admission.js'
export * from './code-host.js'
export * from './config.js'
export * from './delivery.js'
export * from './dispatch.js'
export * from './ingress.js'
export * from './notification.js'
export * from './operations.js'
export * from './publication.js'
export * from './reconciliation.js'
export * from './tracker.js'
export * from './web.js'
export * from './workflow.js'
