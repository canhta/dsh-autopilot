import type { Context } from '@deepseek-ai/cordis'
import { Admission } from './admission.js'
import { Tracker } from './tracker.js'

export const name = 'dsh-autopilot'
export const inject = ['settings', 'storageDomain']

export async function apply(ctx: Context): Promise<void> {
  await ctx.plugin(Tracker)
  await ctx.plugin(Admission)
}

export * from './admission.js'
export * from './tracker.js'
