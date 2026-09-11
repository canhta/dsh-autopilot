import type { Context } from '@deepseek-ai/cordis'
import { Admission } from './admission.js'
import { Dispatch } from './dispatch.js'
import { Tracker } from './tracker.js'

export const name = 'dsh-autopilot'
export const inject = ['settings', 'storageDomain']

export async function apply(ctx: Context): Promise<void> {
  await ctx.plugin(Tracker)
  await ctx.plugin(Admission)
  await ctx.plugin(Dispatch)
}

export * from './admission.js'
export * from './dispatch.js'
export * from './tracker.js'
