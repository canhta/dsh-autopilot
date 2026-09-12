import { z } from 'zod'
import { readinessGeneration, trackerBindingId, trackerCommentId, trackerIssueId } from './model.js'

const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,255}$/

const commentSchema = z.object({
  id: z.string().min(1).max(256).transform(trackerCommentId),
  authorId: z.string().min(1).max(256),
  body: z.string(),
  updatedAt: z.iso.datetime({ offset: true }),
})

const dependencySchema = z.object({
  issueId: z.string().min(1).max(256).transform(trackerIssueId),
  displayKey: z.string().min(1).max(256),
  state: z.enum(['completed', 'not-completed', 'unknown']),
})

const readinessSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('absent') }),
  z.object({
    kind: z.literal('transition'),
    generation: z.string().min(1).max(256).transform(readinessGeneration),
    actorId: z.string().min(1).max(256),
    actorKind: z.enum(['human', 'automation', 'unknown']),
    occurredAt: z.iso.datetime({ offset: true }),
  }),
])

export const candidatePageSchema = z.object({
  issues: z.array(
    z.object({
      bindingId: z.string().min(1).max(256).transform(trackerBindingId),
      issueId: z.string().min(1).max(256).transform(trackerIssueId),
      displayKey: z.string().min(1).max(256),
      summary: z.string(),
      priorityRank: z.number().int().nonnegative(),
      isReady: z.boolean(),
      labels: z.array(z.string()),
      comments: z.array(commentSchema),
      dependencies: z.array(dependencySchema),
      readiness: readinessSchema,
    }),
  ),
  nextCursor: z.string().min(1).max(4096).optional(),
})

export const ingressDeliverySchema = z.object({
  deliveryId: z.string().min(1).max(512).regex(ID_PATTERN),
})

export const outboundReceiptSchema = z.object({
  receiptId: z.string().min(1).max(512),
  receivedAt: z.iso.datetime({ offset: true }),
})

export const deliveryObservationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('missing') }),
  z.object({ kind: z.literal('delivered'), receipt: outboundReceiptSchema }),
  z.object({ kind: z.literal('conflict'), reason: z.string().min(1).max(4096) }),
])
