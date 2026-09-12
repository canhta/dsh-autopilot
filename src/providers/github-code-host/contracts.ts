import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  arrayItemsAreStrings,
  decodeMcpJson,
  defineMcpContracts,
  hasInputShape,
  hasNoArgumentObjectInput,
} from '../../mcp/index.js'
import {
  branchesSchema,
  commitSchema,
  createPullRequestSchema,
  identitySchema,
  pullRequestSchema,
  pullRequestsSchema,
  referenceSchema,
  treeSchema,
} from './schemas.js'

export const githubCodeHostMcpContracts = defineMcpContracts({
  readIdentity: {
    rawName: 'get_me',
    maxResultBytes: 256 * 1024,
    acceptsDefinition: hasNoArgumentObjectInput,
    encode: (_input: Record<string, never>) => ({}),
    decode: (result) => decodeMcpJson(result, identitySchema),
  },
  readCommit: {
    rawName: 'get_commit',
    maxResultBytes: 512 * 1024,
    acceptsDefinition: (definition: ToolDefinition) =>
      hasInputShape(definition, ['owner', 'repo', 'sha'], {
        owner: 'string',
        repo: 'string',
        sha: 'string',
        detail: 'string',
      }),
    encode: (input: { owner: string; repo: string; sha: string }) => ({ ...input, detail: 'none' }),
    decode: (result) => decodeMcpJson(result, commitSchema),
  },
  readTree: {
    rawName: 'get_repository_tree',
    maxResultBytes: 4 * 1024 * 1024,
    acceptsDefinition: (definition: ToolDefinition) =>
      hasInputShape(definition, ['owner', 'repo'], {
        owner: 'string',
        repo: 'string',
        tree_sha: 'string',
        recursive: 'boolean',
      }),
    encode: (input: { owner: string; repo: string; ref: string }) => ({
      owner: input.owner,
      repo: input.repo,
      tree_sha: input.ref,
      recursive: true,
    }),
    decode: (result) => decodeMcpJson(result, treeSchema),
  },
  listBranches: {
    rawName: 'list_branches',
    maxResultBytes: 512 * 1024,
    acceptsDefinition: (definition: ToolDefinition) =>
      hasInputShape(definition, ['owner', 'repo'], {
        owner: 'string',
        repo: 'string',
        page: 'number',
        perPage: 'number',
      }),
    encode: (input: { owner: string; repo: string; page: number; pageSize: number }) => ({
      owner: input.owner,
      repo: input.repo,
      page: input.page,
      perPage: input.pageSize,
    }),
    decode: (result) => decodeMcpJson(result, branchesSchema),
  },
  listPullRequests: {
    rawName: 'list_pull_requests',
    maxResultBytes: 2 * 1024 * 1024,
    acceptsDefinition: (definition: ToolDefinition) =>
      hasInputShape(definition, ['owner', 'repo'], {
        owner: 'string',
        repo: 'string',
        head: 'string',
        base: 'string',
        state: 'string',
        fields: 'array',
        page: 'number',
        perPage: 'number',
      }) && arrayItemsAreStrings(definition, 'fields'),
    encode: (input: { owner: string; repo: string; head: string; base: string; page: number; pageSize: number }) => ({
      owner: input.owner,
      repo: input.repo,
      head: input.head,
      base: input.base,
      state: 'all',
      fields: ['number', 'body', 'state', 'draft', 'merged', 'html_url', 'head', 'base'],
      perPage: input.pageSize,
      page: input.page,
    }),
    decode: (result) => decodeMcpJson(result, pullRequestsSchema),
  },
  readPullRequest: {
    rawName: 'pull_request_read',
    maxResultBytes: 512 * 1024,
    acceptsDefinition: (definition: ToolDefinition) =>
      hasInputShape(definition, ['method', 'owner', 'repo', 'pullNumber'], {
        method: 'string',
        owner: 'string',
        repo: 'string',
        pullNumber: 'number',
      }),
    encode: (input: { owner: string; repo: string; pullNumber: number }) => ({ ...input, method: 'get' }),
    decode: (result) => decodeMcpJson(result, pullRequestSchema),
  },
  createBranch: {
    rawName: 'create_branch',
    maxResultBytes: 512 * 1024,
    acceptsDefinition: (definition: ToolDefinition) =>
      hasInputShape(definition, ['owner', 'repo', 'branch'], {
        owner: 'string',
        repo: 'string',
        branch: 'string',
        from_branch: 'string',
      }),
    encode: (input: { owner: string; repo: string; branch: string; base: string }) => ({
      owner: input.owner,
      repo: input.repo,
      branch: input.branch,
      from_branch: input.base,
    }),
    decode: (result) => decodeMcpJson(result, referenceSchema),
  },
  pushFiles: {
    rawName: 'push_files',
    maxResultBytes: 512 * 1024,
    acceptsDefinition: (definition: ToolDefinition) =>
      hasInputShape(definition, ['owner', 'repo', 'branch', 'files', 'message'], {
        owner: 'string',
        repo: 'string',
        branch: 'string',
        files: 'array',
        message: 'string',
      }),
    encode: (input: {
      owner: string
      repo: string
      branch: string
      files: readonly { path: string; content: string }[]
      message: string
    }) => input,
    decode: (result) => decodeMcpJson(result, referenceSchema),
  },
  createPullRequest: {
    rawName: 'create_pull_request',
    maxResultBytes: 512 * 1024,
    acceptsDefinition: (definition: ToolDefinition) =>
      hasInputShape(definition, ['owner', 'repo', 'title', 'head', 'base'], {
        owner: 'string',
        repo: 'string',
        title: 'string',
        head: 'string',
        base: 'string',
        body: 'string',
        draft: 'boolean',
      }),
    encode: (input: { owner: string; repo: string; title: string; head: string; base: string; body: string }) => ({
      ...input,
      draft: false,
      maintainer_can_modify: true,
    }),
    decode: (result) => decodeMcpJson(result, createPullRequestSchema),
  },
})
