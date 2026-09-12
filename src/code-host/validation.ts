import { z } from 'zod'
import { pullRequestId } from './model.js'

const sha = z.string().regex(/^[a-f0-9]{40}$/)
const receiptSchema = z.object({
  id: z.string().min(1).max(256).transform(pullRequestId),
  number: z.number().int().positive().safe(),
  url: z.url().max(4096),
  state: z.enum(['open', 'merged', 'closed-unmerged']),
  baseBranch: z.string().min(1).max(256),
  headBranch: z.string().min(1).max(256),
  remoteHead: sha,
})

const branchSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('missing') }),
  z.object({ kind: z.literal('base'), remoteHead: sha }),
  z.object({ kind: z.literal('published'), remoteHead: sha }),
  z.object({ kind: z.literal('conflict'), remoteHead: sha }),
])

const pullRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('missing') }),
  z.object({ kind: z.literal('matching'), receipt: receiptSchema }),
  z.object({ kind: z.literal('conflict'), reason: z.string().min(1).max(4096) }),
])

export const reconciliationSchema = z.object({
  baseHead: sha,
  branch: branchSchema,
  pullRequest: pullRequestSchema,
})

export { receiptSchema as pullRequestReceiptSchema }
