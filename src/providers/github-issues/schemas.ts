import { z } from 'zod'

const githubId = z.number().int().positive().safe()
const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().min(1).max(4096).optional(),
})

export const issueSchema = z.object({
  number: z.number().int().positive().safe(),
  title: z.string().max(65_536),
  state: z.enum(['OPEN', 'CLOSED']),
  labels: z.array(z.string().max(255)).max(256),
  created_at: z.string().min(1).max(128),
})

export const issuesPageSchema = z.object({
  issues: z.array(issueSchema).max(100),
  totalCount: z.number().int().nonnegative(),
  pageInfo: pageInfoSchema,
})

export const commentSchema = z.object({
  id: githubId,
  user: z.object({ id: githubId }).nullable().optional(),
  body: z.string().max(1_048_576).optional(),
  updated_at: z.string().min(1).max(128),
})

export const commentsPageSchema = z.array(commentSchema).max(100)

export const timelineEventSchema = z.object({
  id: githubId,
  event: z.enum(['labeled', 'unlabeled']),
  created_at: z.string().min(1).max(128),
  actor: z.object({ id: githubId, type: z.string().min(1).max(64) }).nullable(),
  label: z.object({ name: z.string().max(255) }),
  performed_via_github_app: z.object({ id: githubId }).nullable().optional(),
  repository_id: githubId,
})

export const timelinePageSchema = z.object({
  events: z.array(timelineEventSchema).max(100),
  pageInfo: z.object({
    hasNextPage: z.boolean(),
    nextPage: z.number().int().positive().safe().optional(),
  }),
})

export const dependencySchema = z.object({
  number: z.number().int().positive().safe(),
  state: z.enum(['OPEN', 'CLOSED']),
  repository: z.string().min(3).max(202),
})

export const dependenciesPageSchema = z.object({
  issues: z.array(dependencySchema).max(100),
  pageInfo: z.union([
    z.object({ hasNextPage: z.literal(true), nextPage: z.number().int().positive().safe() }),
    z.object({ hasNextPage: z.literal(false), nextPage: z.literal(0).optional() }),
  ]),
})

export const webhookBodySchema = z.object({
  repository: z.object({ id: githubId }),
  action: z.string().min(1).max(128).optional(),
})

export type GitHubIssue = z.infer<typeof issueSchema>
export type GitHubComment = z.infer<typeof commentSchema>
export type GitHubTimelineEvent = z.infer<typeof timelineEventSchema>
export type GitHubDependency = z.infer<typeof dependencySchema>
