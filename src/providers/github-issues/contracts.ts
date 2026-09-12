import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import {
  arrayItemEnumIncludes,
  arrayItemsAreStrings,
  decodeMcpJson,
  defineMcpContracts,
  hasInputShape,
  hasNoArgumentObjectInput,
  propertyEnumIncludes,
} from '../../mcp/index.js'
import { commentsPageSchema, dependenciesPageSchema, issuesPageSchema, timelinePageSchema } from './schemas.js'

const issueDetailSchema = z.object({
  number: z.number().int().positive().safe(),
  state: z.enum(['open', 'closed']),
  state_reason: z.string().max(64).optional(),
})
const identitySchema = z.object({ id: z.number().int().positive().safe() })

export interface GitHubCoordinate {
  owner: string
  repo: string
  issueNumber: number
}

export const githubMcpContracts = defineMcpContracts({
  readIdentity: {
    rawName: 'get_me',
    maxResultBytes: 256 * 1024,
    acceptsDefinition: hasNoArgumentObjectInput,
    encode: (_input: Record<string, never>) => ({}),
    decode: (result) => decodeMcpJson(result, identitySchema),
  },
  listCandidates: {
    rawName: 'list_issues',
    maxResultBytes: 2 * 1024 * 1024,
    acceptsDefinition: (definition: ToolDefinition) =>
      hasInputShape(definition, ['owner', 'repo'], {
        owner: 'string',
        repo: 'string',
        state: 'string',
        labels: 'array',
        orderBy: 'string',
        direction: 'string',
        fields: 'array',
        perPage: 'number',
        after: 'string',
      }) &&
      propertyEnumIncludes(definition, 'state', 'OPEN') &&
      propertyEnumIncludes(definition, 'orderBy', 'CREATED_AT') &&
      propertyEnumIncludes(definition, 'direction', 'ASC') &&
      arrayItemsAreStrings(definition, 'labels') &&
      arrayItemsAreStrings(definition, 'fields') &&
      ['number', 'title', 'state', 'labels', 'created_at'].every((field) =>
        arrayItemEnumIncludes(definition, 'fields', field),
      ),
    encode(input: { owner: string; repo: string; label: string; pageSize: number; after?: string }) {
      return {
        owner: input.owner,
        repo: input.repo,
        state: 'OPEN',
        labels: [input.label],
        orderBy: 'CREATED_AT',
        direction: 'ASC',
        fields: ['number', 'title', 'state', 'labels', 'created_at'],
        perPage: input.pageSize,
        ...(input.after === undefined ? {} : { after: input.after }),
      }
    },
    decode: (result) => decodeMcpJson(result, issuesPageSchema),
  },
  readComments: {
    rawName: 'issue_read',
    maxResultBytes: 2 * 1024 * 1024,
    acceptsDefinition: acceptsIssueRead,
    encode(input: GitHubCoordinate & { page: number; pageSize: number }) {
      return issueReadInput(input, 'get_comments')
    },
    decode: (result) => decodeMcpJson(result, commentsPageSchema),
  },
  readDependencies: {
    rawName: 'issue_dependency_read',
    maxResultBytes: 2 * 1024 * 1024,
    acceptsDefinition: (definition: ToolDefinition) =>
      hasInputShape(definition, ['method', 'owner', 'repo', 'issue_number'], {
        method: 'string',
        owner: 'string',
        repo: 'string',
        issue_number: 'number',
        page: 'number',
        perPage: 'number',
      }) && methodIncludes(definition, 'get_blocked_by'),
    encode(input: GitHubCoordinate & { page: number; pageSize: number }) {
      return {
        method: 'get_blocked_by',
        owner: input.owner,
        repo: input.repo,
        issue_number: input.issueNumber,
        page: input.page,
        perPage: input.pageSize,
      }
    },
    decode: (result) => decodeMcpJson(result, dependenciesPageSchema),
  },
  readIssue: {
    rawName: 'issue_read',
    maxResultBytes: 2 * 1024 * 1024,
    acceptsDefinition: acceptsIssueRead,
    encode(input: GitHubCoordinate) {
      return issueReadInput(input, 'get')
    },
    decode: (result) => decodeMcpJson(result, issueDetailSchema),
  },
  readReadinessHistory: {
    rawName: 'autopilot_read_issue_timeline',
    maxResultBytes: 2 * 1024 * 1024,
    acceptsDefinition: (definition: ToolDefinition) =>
      hasInputShape(definition, ['owner', 'repo', 'issue_number'], {
        owner: 'string',
        repo: 'string',
        issue_number: 'number',
        page: 'number',
        perPage: 'number',
      }),
    encode(input: GitHubCoordinate & { page: number; pageSize: number }) {
      return {
        owner: input.owner,
        repo: input.repo,
        issue_number: input.issueNumber,
        page: input.page,
        perPage: input.pageSize,
      }
    },
    decode: (result) => decodeMcpJson(result, timelinePageSchema),
  },
})

function issueReadInput(input: GitHubCoordinate & { page?: number; pageSize?: number }, method: string): object {
  return {
    method,
    owner: input.owner,
    repo: input.repo,
    issue_number: input.issueNumber,
    ...(input.page === undefined ? {} : { page: input.page }),
    ...(input.pageSize === undefined ? {} : { perPage: input.pageSize }),
  }
}

function acceptsIssueRead(definition: ToolDefinition): boolean {
  return (
    hasInputShape(definition, ['method', 'owner', 'repo', 'issue_number'], {
      method: 'string',
      owner: 'string',
      repo: 'string',
      issue_number: 'number',
      page: 'number',
      perPage: 'number',
    }) &&
    methodIncludes(definition, 'get') &&
    methodIncludes(definition, 'get_comments')
  )
}

function methodIncludes(definition: ToolDefinition, value: string): boolean {
  return propertyEnumIncludes(definition, 'method', value)
}
