import type { ConnectionHandle, ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AutopilotRemoteNamespace } from '../remote.js'
import type {
  CleanupPreviewView,
  CommandKind,
  CommandReceipt,
  CommandRequest,
  OperationsQuery,
  OperationsSnapshot,
  ProviderTestResult,
  RunDetailView,
  WorktreeView,
} from '../web/contract.js'

export type QueryState<T> =
  | { readonly status: 'loading'; readonly data?: T }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'stale'; readonly data: T; readonly message: string }
  | { readonly status: 'error'; readonly message: string }

type PendingCommand = {
  readonly requestId: string
  readonly status: 'pending'
  readonly kind: CommandKind
  readonly runId?: string
  readonly deliveryId?: string
  readonly previewId?: string
  readonly message?: string
}

export interface OperationsClientState {
  query: OperationsQuery
  operations: QueryState<OperationsSnapshot>
  connection: ConnectionState | 'unknown'
  command?: CommandReceipt | PendingCommand
}

const initialQuery: OperationsQuery = { offset: 0, limit: 50 }

/** Shared cancellable query/command state for the Operations panel and Settings contribution. */
export class OperationsController {
  readonly store: SnapshotStore<OperationsClientState>
  private activeViews = 0
  private refreshTimer: ReturnType<typeof setInterval> | undefined
  private refreshRequest: AbortController | undefined
  private readonly lifetime = new AbortController()
  private readonly following = new Set<string>()
  private pendingRequest: CommandRequest | undefined
  private requestGeneration = 0
  private disposed = false

  constructor(
    private readonly remote: AutopilotRemoteNamespace,
    private readonly connection: ConnectionHandle,
    subscribeReset: (listener: () => void) => () => void,
  ) {
    this.store = createSnapshotStore<OperationsClientState>({
      query: initialQuery,
      operations: { status: 'loading' },
      connection: connection.state.getSnapshot() ?? 'unknown',
    })
    const stopConnection = connection.state.subscribe(() => {
      const state = connection.state.getSnapshot() ?? 'unknown'
      this.store.update((draft) => {
        draft.connection = state
        if (state !== 'connected' && draft.operations.status === 'ready') {
          draft.operations = {
            status: 'stale',
            data: draft.operations.data,
            message: 'Host connection lost. Showing the last received state.',
          }
        }
      })
    })
    const stopReset = subscribeReset(() => {
      void this.refresh()
      void this.recoverCommand()
    })
    this.disposeSubscriptions = () => {
      stopConnection()
      stopReset()
    }
  }

  private readonly disposeSubscriptions: () => void

  connect(): () => void {
    if (this.disposed) return () => {}
    this.activeViews += 1
    if (this.activeViews === 1) {
      void this.refresh()
      void this.recoverCommand()
      this.refreshTimer = setInterval(() => void this.refresh(), 5_000)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.activeViews -= 1
      if (this.activeViews === 0 && this.refreshTimer !== undefined) {
        clearInterval(this.refreshTimer)
        this.refreshTimer = undefined
      }
    }
  }

  setQuery(patch: Partial<OperationsQuery>): void {
    this.store.update((draft) => {
      draft.query = { ...draft.query, ...patch, offset: patch.offset ?? 0 }
    })
    void this.refresh()
  }

  async refresh(): Promise<void> {
    const generation = ++this.requestGeneration
    const previous = dataOf(this.store.getSnapshot().operations)
    this.refreshRequest?.abort()
    const request = new AbortController()
    this.refreshRequest = request
    const signal = combineSignals(this.lifetime.signal, request.signal)
    this.store.update((draft) => {
      draft.operations = { status: 'loading', ...(previous === undefined ? {} : { data: previous }) }
    })
    let result: Awaited<ReturnType<AutopilotRemoteNamespace['operations']>>
    try {
      result = await this.remote.operations(this.store.getSnapshot().query, signal)
    } catch (error) {
      if (signal.aborted || generation !== this.requestGeneration || this.disposed) return
      const message = failureMessage(error)
      this.store.update((draft) => {
        draft.operations =
          previous === undefined ? { status: 'error', message } : { status: 'stale', data: previous, message }
      })
      return
    }
    if (signal.aborted || generation !== this.requestGeneration || this.disposed) return
    if (result.ok) {
      this.store.update((draft) => {
        draft.operations = { status: 'ready', data: result.value }
        if (draft.command === undefined) {
          const active = result.value.commands.findLast(
            ({ status }) => status === 'accepted' || status === 'in-progress',
          )
          if (active !== undefined) draft.command = active
        }
      })
      const active = this.store.getSnapshot().command
      if (active?.status === 'accepted' || active?.status === 'in-progress') void this.followCommand(active.requestId)
      return
    }
    const message = `${result.error.code}: ${result.error.message}`
    this.store.update((draft) => {
      draft.operations =
        previous === undefined ? { status: 'error', message } : { status: 'stale', data: previous, message }
    })
  }

  async runCommand(
    kind: CommandKind,
    target: Pick<CommandRequest, 'runId' | 'deliveryId' | 'previewId'> = {},
  ): Promise<void> {
    if (commandActive(this.store.getSnapshot().command)) return
    const request: CommandRequest = {
      requestId: crypto.randomUUID(),
      kind,
      ...target,
    }
    if (this.connection.state.getSnapshot() !== 'connected') {
      this.store.update((draft) => {
        draft.command = rejectedReceipt(request.requestId, kind, 'Reconnect to the Host before retrying this command.')
      })
      return
    }
    this.pendingRequest = request
    this.setPending(request)
    await this.submitCommand(request)
  }

  async loadRun(runId: string, signal?: AbortSignal): Promise<RunDetailView | null> {
    const combined = signal === undefined ? this.lifetime.signal : combineSignals(this.lifetime.signal, signal)
    const result = await this.remote.run(runId, combined)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  }

  async inspectWorktree(runId: string, signal?: AbortSignal): Promise<WorktreeView | null> {
    const combined = signal === undefined ? this.lifetime.signal : combineSignals(this.lifetime.signal, signal)
    const result = await this.remote.worktree(runId, combined)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  }

  async previewCleanup(runId: string, signal?: AbortSignal): Promise<CleanupPreviewView | null> {
    const combined = signal === undefined ? this.lifetime.signal : combineSignals(this.lifetime.signal, signal)
    const result = await this.remote.previewCleanup(runId, combined)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  }

  async testProvider(providerId: string, signal?: AbortSignal): Promise<ProviderTestResult> {
    const combined = signal === undefined ? this.lifetime.signal : combineSignals(this.lifetime.signal, signal)
    const result = await this.remote.testProvider(providerId, combined)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  }

  dispose(): void {
    this.disposed = true
    this.requestGeneration += 1
    this.lifetime.abort(new Error('Autopilot Client contribution disposed'))
    this.refreshRequest?.abort()
    if (this.refreshTimer !== undefined) clearInterval(this.refreshTimer)
    this.disposeSubscriptions()
  }

  private async submitCommand(request: CommandRequest): Promise<void> {
    let result: Awaited<ReturnType<AutopilotRemoteNamespace['command']>>
    try {
      result = await this.remote.command(request, this.lifetime.signal)
    } catch {
      if (this.lifetime.signal.aborted) return
      this.setPending(request, `Delivery was interrupted; Autopilot will reconcile request ${request.requestId}.`)
      await this.followCommand(request.requestId)
      return
    }
    if (this.lifetime.signal.aborted) return
    if (!result.ok) {
      this.pendingRequest = undefined
      this.store.update((draft) => {
        draft.command = rejectedReceipt(
          request.requestId,
          request.kind,
          `${result.error.code}: ${result.error.message}`,
        )
      })
      return
    }
    this.store.update((draft) => {
      draft.command = result.value
    })
    if (result.value.status === 'succeeded' || result.value.status === 'rejected') {
      this.pendingRequest = undefined
      await this.refresh()
      return
    }
    await this.followCommand(request.requestId)
  }

  private async recoverCommand(): Promise<void> {
    if (this.disposed || this.connection.state.getSnapshot() !== 'connected') return
    const request = this.pendingRequest
    if (request !== undefined) {
      let result: Awaited<ReturnType<AutopilotRemoteNamespace['commandStatus']>>
      try {
        result = await this.remote.commandStatus(request.requestId, this.lifetime.signal)
      } catch {
        return
      }
      if (!result.ok) return
      if (result.value === null) {
        await this.submitCommand(request)
        return
      }
      const receipt = result.value
      this.store.update((draft) => {
        draft.command = receipt
      })
      await this.followCommand(request.requestId)
      return
    }
    const current = this.store.getSnapshot().command
    if (current?.status === 'accepted' || current?.status === 'in-progress') await this.followCommand(current.requestId)
  }

  private async followCommand(requestId: string): Promise<void> {
    if (this.following.has(requestId)) return
    this.following.add(requestId)
    try {
      for (;;) {
        if (this.disposed) return
        const current = this.store.getSnapshot().command
        if (current?.status === 'succeeded' || current?.status === 'rejected') {
          this.pendingRequest = undefined
          await this.refresh()
          return
        }
        try {
          await abortableDelay(350, this.lifetime.signal)
          const result = await this.remote.commandStatus(requestId, this.lifetime.signal)
          if (!result.ok) {
            this.pendingRequest = undefined
            this.store.update((draft) => {
              draft.command = rejectedReceipt(requestId, current?.kind ?? 'reconcile', result.error.message)
            })
            return
          }
          if (result.value === null) {
            const pending = this.pendingRequest
            if (pending !== undefined) {
              await this.submitCommand(pending)
              continue
            } else
              this.store.update((draft) => {
                draft.command = rejectedReceipt(
                  requestId,
                  current?.kind ?? 'reconcile',
                  'Host lost the command record.',
                )
              })
            return
          }
          const receipt = result.value
          this.store.update((draft) => {
            draft.command = receipt
          })
        } catch {
          if (this.lifetime.signal.aborted) return
        }
      }
    } finally {
      this.following.delete(requestId)
    }
  }

  private setPending(request: CommandRequest, message?: string): void {
    this.store.update((draft) => {
      draft.command = {
        requestId: request.requestId,
        kind: request.kind,
        status: 'pending',
        ...(request.runId === undefined ? {} : { runId: request.runId }),
        ...(request.deliveryId === undefined ? {} : { deliveryId: request.deliveryId }),
        ...(request.previewId === undefined ? {} : { previewId: request.previewId }),
        ...(message === undefined ? {} : { message }),
      }
    })
  }
}

function dataOf(state: QueryState<OperationsSnapshot>): OperationsSnapshot | undefined {
  return 'data' in state ? state.data : undefined
}

function commandActive(command: OperationsClientState['command']): boolean {
  return command?.status === 'pending' || command?.status === 'accepted' || command?.status === 'in-progress'
}

function rejectedReceipt(requestId: string, kind: CommandKind, message: string): CommandReceipt {
  const now = new Date().toISOString()
  return { requestId, kind, status: 'rejected', acceptedAt: now, finishedAt: now, message }
}

function combineSignals(first: AbortSignal, second: AbortSignal): AbortSignal {
  return AbortSignal.any([first, second])
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = (): void => {
      clearTimeout(timeout)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The Remote operation failed.'
}
