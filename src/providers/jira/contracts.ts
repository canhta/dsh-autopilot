import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import {
  arrayItemsAreStrings,
  decodeMcpJson,
  defineMcpReadContracts,
  hasInputShape,
  hasNoArgumentObjectInput,
} from '../../mcp/index.js'
import { changelogPageSchema, commentsPageSchema, searchSchema } from './schemas.js'

const identitySchema = z.object({ account_id: z.string().min(1).max(256) })

export const jiraMcpContracts = defineMcpReadContracts({
  readIdentity: {
    rawName: 'atlassianUserInfo',
    maxResultBytes: 256 * 1024,
    acceptsDefinition: hasNoArgumentObjectInput,
    encode: (_input: Record<string, never>) => ({}),
    decode: (result) => decodeMcpJson(result, identitySchema),
  },
  searchCandidates: {
    rawName: 'searchJiraIssuesUsingJql',
    maxResultBytes: 2 * 1024 * 1024,
    acceptsDefinition: (definition: ToolDefinition) =>
      hasInputShape(definition, ['cloudId', 'jql'], {
        cloudId: 'string',
        jql: 'string',
        fields: 'array',
        maxResults: 'number',
        nextPageToken: 'string',
      }) && arrayItemsAreStrings(definition, 'fields'),
    encode(input: { cloudId: string; jql: string; pageSize: number; nextPageToken?: string }) {
      return {
        cloudId: input.cloudId,
        jql: input.jql,
        fields: ['summary', 'priority', 'labels', 'project', 'issuelinks'],
        maxResults: input.pageSize,
        ...(input.nextPageToken === undefined ? {} : { nextPageToken: input.nextPageToken }),
      }
    },
    decode: (result) => decodeMcpJson(result, searchSchema),
  },
  readComments: {
    rawName: 'listJiraIssueComments',
    maxResultBytes: 2 * 1024 * 1024,
    acceptsDefinition: (definition: ToolDefinition) =>
      hasInputShape(definition, ['cloudId', 'issueIdOrKey'], {
        cloudId: 'string',
        issueIdOrKey: 'string',
        startAt: 'number',
        maxResults: 'number',
      }),
    encode(input: { cloudId: string; issueKey: string; startAt: number; pageSize: number }) {
      return {
        cloudId: input.cloudId,
        issueIdOrKey: input.issueKey,
        startAt: input.startAt,
        maxResults: input.pageSize,
      }
    },
    decode: (result) => decodeMcpJson(result, commentsPageSchema),
  },
  readChangelogs: {
    rawName: 'listJiraIssueChangelogs',
    maxResultBytes: 2 * 1024 * 1024,
    acceptsDefinition: (definition: ToolDefinition) =>
      hasInputShape(definition, ['cloudId', 'issueIdOrKey'], {
        cloudId: 'string',
        issueIdOrKey: 'string',
        startAt: 'number',
        maxResults: 'number',
      }),
    encode(input: { cloudId: string; issueKey: string; startAt: number; pageSize: number }) {
      return {
        cloudId: input.cloudId,
        issueIdOrKey: input.issueKey,
        startAt: input.startAt,
        maxResults: input.pageSize,
      }
    },
    decode: (result) => decodeMcpJson(result, changelogPageSchema),
  },
})
