import { z } from 'zod'

export const issueSchema = z.object({
  id: z.string().min(1).max(256),
  key: z.string().min(1).max(256),
  fields: z.object({
    summary: z.string(),
    priority: z
      .object({ id: z.string().min(1).max(256) })
      .nullable()
      .optional(),
    labels: z.array(z.string()),
    issuelinks: z.array(z.unknown()).default([]),
  }),
})

export const searchSchema = z.object({
  issues: z.array(issueSchema),
  nextPageToken: z.string().min(1).max(4096).optional(),
})

export const commentSchema = z.object({
  id: z.string().min(1).max(256),
  author: z.object({ accountId: z.string().min(1).max(256).optional() }).optional(),
  updated: z.string().min(1).max(128),
  body: z.unknown(),
})

export const commentsPageSchema = z.object({
  startAt: z.number().int().nonnegative(),
  maxResults: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  comments: z.array(commentSchema),
})

const changelogItemSchema = z.object({
  fieldId: z.string().optional(),
  field: z.string().optional(),
  fromString: z.string().nullable().optional(),
  toString: z.string().nullable().optional(),
})

export const changelogSchema = z.object({
  id: z.string().min(1).max(256),
  created: z.string().min(1).max(128),
  author: z
    .object({
      accountId: z.string().min(1).max(256).optional(),
      accountType: z.string().min(1).max(64).optional(),
    })
    .optional(),
  items: z.array(changelogItemSchema),
})

export const changelogPageSchema = z.object({
  startAt: z.number().int().nonnegative(),
  maxResults: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  values: z.array(changelogSchema),
})

export const webhookBodySchema = z.object({
  timestamp: z.number().int().nonnegative(),
  webhookEvent: z.string().min(1).max(256),
})

export const linkSchema = z.object({
  type: z.object({ id: z.string().min(1).max(256) }),
  inwardIssue: z.unknown().optional(),
  outwardIssue: z.unknown().optional(),
})

export const linkedIssueSchema = z.object({
  id: z.string().min(1).max(256),
  key: z.string().min(1).max(256),
  fields: z.object({ status: z.object({ id: z.string().min(1).max(256) }).optional() }).optional(),
})

export type JiraIssue = z.infer<typeof issueSchema>
export type JiraChangelog = z.infer<typeof changelogSchema>
