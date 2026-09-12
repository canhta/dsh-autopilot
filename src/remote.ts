import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import {
  type CleanupPreviewView,
  type CommandReceipt,
  type CommandRequest,
  cleanupPreviewViewSchema,
  commandReceiptSchema,
  commandRequestSchema,
  type OperationsQuery,
  type OperationsSnapshot,
  operationsQuerySchema,
  operationsSnapshotSchema,
  type ProviderTestResult,
  providerTestResultSchema,
  type RunDetailView,
  runDetailSchema,
  type WorktreeView,
  worktreeViewSchema,
} from './web/contract.js'

export interface AutopilotRemoteNamespace {
  operations: (query: OperationsQuery, signal?: AbortSignal) => Promise<RemoteResult<OperationsSnapshot>>
  run: (runId: string, signal?: AbortSignal) => Promise<RemoteResult<RunDetailView | null>>
  worktree: (runId: string, signal?: AbortSignal) => Promise<RemoteResult<WorktreeView | null>>
  previewCleanup: (runId: string, signal?: AbortSignal) => Promise<RemoteResult<CleanupPreviewView | null>>
  command: (request: CommandRequest, signal?: AbortSignal) => Promise<RemoteResult<CommandReceipt>>
  commandStatus: (requestId: string, signal?: AbortSignal) => Promise<RemoteResult<CommandReceipt | null>>
  testProvider: (providerId: string, signal?: AbortSignal) => Promise<RemoteResult<ProviderTestResult>>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'autopilot/operations': AutopilotRemoteNamespace['operations']
    'autopilot/run': AutopilotRemoteNamespace['run']
    'autopilot/worktree': AutopilotRemoteNamespace['worktree']
    'autopilot/previewCleanup': AutopilotRemoteNamespace['previewCleanup']
    'autopilot/command': AutopilotRemoteNamespace['command']
    'autopilot/commandStatus': AutopilotRemoteNamespace['commandStatus']
    'autopilot/testProvider': AutopilotRemoteNamespace['testProvider']
  }

  interface TypertRemoteNamespaceMap {
    autopilot: AutopilotRemoteNamespace
  }
}

const strict = (typeSymbol: string, schema: z.ZodType) => ({ mode: 'strict' as const, typeSymbol, schema })
const stringSchema = z.string()

const descriptors = [
  {
    id: 'dsh-autopilot#autopilot/operations',
    service: 'autopilotWeb',
    namespace: 'autopilot',
    method: 'operations',
    invocation: { kind: 'direct' as const },
    parameters: [
      {
        name: 'query',
        wire: 'query',
        source: 'json' as const,
        codec: strict('dsh-autopilot#autopilot/operations:query', operationsQuerySchema),
      },
    ],
    cancellation: { parameter: 'signal' as const },
    result: strict('dsh-autopilot#autopilot/operations:result', operationsSnapshotSchema),
  },
  {
    id: 'dsh-autopilot#autopilot/run',
    service: 'autopilotWeb',
    namespace: 'autopilot',
    method: 'run',
    invocation: { kind: 'direct' as const },
    parameters: [
      {
        name: 'runId',
        wire: 'runId',
        source: 'json' as const,
        codec: strict('dsh-autopilot#autopilot/run:runId', stringSchema),
      },
    ],
    cancellation: { parameter: 'signal' as const },
    result: strict('dsh-autopilot#autopilot/run:result', runDetailSchema.nullable()),
  },
  {
    id: 'dsh-autopilot#autopilot/worktree',
    service: 'autopilotWeb',
    namespace: 'autopilot',
    method: 'worktree',
    invocation: { kind: 'direct' as const },
    parameters: [
      {
        name: 'runId',
        wire: 'runId',
        source: 'json' as const,
        codec: strict('dsh-autopilot#autopilot/worktree:runId', stringSchema),
      },
    ],
    cancellation: { parameter: 'signal' as const },
    result: strict('dsh-autopilot#autopilot/worktree:result', worktreeViewSchema.nullable()),
  },
  {
    id: 'dsh-autopilot#autopilot/previewCleanup',
    service: 'autopilotWeb',
    namespace: 'autopilot',
    method: 'previewCleanup',
    invocation: { kind: 'direct' as const },
    parameters: [
      {
        name: 'runId',
        wire: 'runId',
        source: 'json' as const,
        codec: strict('dsh-autopilot#autopilot/previewCleanup:runId', stringSchema),
      },
    ],
    cancellation: { parameter: 'signal' as const },
    result: strict('dsh-autopilot#autopilot/previewCleanup:result', cleanupPreviewViewSchema.nullable()),
  },
  {
    id: 'dsh-autopilot#autopilot/command',
    service: 'autopilotWeb',
    namespace: 'autopilot',
    method: 'command',
    invocation: { kind: 'direct' as const },
    parameters: [
      {
        name: 'input',
        wire: 'input',
        source: 'json' as const,
        codec: strict('dsh-autopilot#autopilot/command:input', commandRequestSchema),
      },
    ],
    cancellation: { parameter: 'signal' as const },
    result: strict('dsh-autopilot#autopilot/command:result', commandReceiptSchema),
  },
  {
    id: 'dsh-autopilot#autopilot/commandStatus',
    service: 'autopilotWeb',
    namespace: 'autopilot',
    method: 'commandStatus',
    invocation: { kind: 'direct' as const },
    parameters: [
      {
        name: 'requestId',
        wire: 'requestId',
        source: 'json' as const,
        codec: strict('dsh-autopilot#autopilot/commandStatus:requestId', stringSchema.uuid()),
      },
    ],
    cancellation: { parameter: 'signal' as const },
    result: strict('dsh-autopilot#autopilot/commandStatus:result', commandReceiptSchema.nullable()),
  },
  {
    id: 'dsh-autopilot#autopilot/testProvider',
    service: 'autopilotWeb',
    namespace: 'autopilot',
    method: 'testProvider',
    invocation: { kind: 'direct' as const },
    parameters: [
      {
        name: 'providerId',
        wire: 'providerId',
        source: 'json' as const,
        codec: strict('dsh-autopilot#autopilot/testProvider:providerId', stringSchema),
      },
    ],
    cancellation: { parameter: 'signal' as const },
    result: strict('dsh-autopilot#autopilot/testProvider:result', providerTestResultSchema),
  },
] satisfies TypertRemoteContribution['descriptors']

export const TYPERT_REMOTE: TypertRemoteContribution = { package: '@canhta/dsh-autopilot', descriptors }

export const TYPERT = {
  package: '@canhta/dsh-autopilot',
  face: 'host',
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: descriptors,
}

export default TYPERT_REMOTE
