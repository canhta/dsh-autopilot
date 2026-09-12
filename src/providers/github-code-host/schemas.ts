import { z } from 'zod'

const sha = z.string().regex(/^[a-f0-9]{40}$/)
export const identitySchema = z.object({ id: z.number().int().positive().safe() })
export const commitSchema = z.object({ sha })
export const branchSchema = z.object({ name: z.string().min(1).max(256), sha, protected: z.boolean() })
export const branchesSchema = z.array(branchSchema).max(100)
export const treeSchema = z.object({
  sha,
  truncated: z.boolean().optional().default(false),
  tree: z
    .array(
      z.object({
        path: z.string().min(1).max(4096),
        mode: z.string().min(1).max(16),
        type: z.enum(['blob', 'tree', 'commit']),
        sha,
      }),
    )
    .max(20_000),
})

const prBranchSchema = z.object({ ref: z.string().min(1).max(256), sha })
export const pullRequestSchema = z.object({
  number: z.number().int().positive().safe(),
  body: z.string().optional().default(''),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  merged: z.boolean(),
  html_url: z.url().max(4096),
  head: prBranchSchema,
  base: prBranchSchema,
})
export const pullRequestsSchema = z.array(pullRequestSchema).max(100)
export const createPullRequestSchema = z.object({
  number: z.number().int().positive().safe(),
  url: z.url().max(4096),
})
export const referenceSchema = z.object({
  ref: z.string().min(1).max(512),
  object: z.object({ sha }),
})

export type GitHubPullRequest = z.infer<typeof pullRequestSchema>
export type GitHubTree = z.infer<typeof treeSchema>
