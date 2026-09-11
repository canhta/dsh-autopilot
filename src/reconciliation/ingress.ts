import type { IncomingMessage, ServerResponse } from 'node:http'
import { type Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { AdmissionIngressError } from '../admission.js'
import { type TrackerIngressHeader, TrackerProviderError } from '../tracker.js'
import { ReconciliationError } from './service.js'

/** Exact Host route that accepts provider-authenticated tracker deliveries. */
export const TRACKER_INGRESS_PATH = '/dsh-autopilot/tracker'
const MAX_INGRESS_BODY_BYTES = 256 * 1024
const MAX_CONCURRENT_INGRESS_HANDLERS = 32

class PayloadTooLargeError extends Error {}

/**
 * Own the bounded Host HTTP adapter for provider-authenticated durable reconciliation.
 *
 * Mounting registers one exact route. Disposal first unregisters it, then aborts partial body reads and drains every
 * active handler, so a retired route cannot call a replacement reconciliation owner. Responses expose only bounded
 * status text; provider, admission, and reconciliation details remain in sanitized operator diagnostics.
 */
export class Ingress extends Service {
  static readonly inject = ['autopilotReconciliation', 'webServer']

  private readonly controller = new AbortController()
  private readonly activeHandlers = new Set<Promise<void>>()
  private stopping = false

  constructor(ctx: Context) {
    super(ctx, 'autopilotIngress')
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    const unregister = this.ctx.webServer.register({
      kind: 'exact',
      path: TRACKER_INGRESS_PATH,
      handler: (request, response) => this.dispatch(request, response),
    })
    yield async () => {
      this.stopping = true
      unregister()
      this.controller.abort(new Error('tracker ingress route was disposed'))
      await Promise.allSettled(this.activeHandlers)
    }
  }

  private dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.stopping) {
      writeResponse(response, 503)
      return Promise.resolve()
    }
    if (this.activeHandlers.size >= MAX_CONCURRENT_INGRESS_HANDLERS) {
      writeResponse(response, 429, 1)
      return Promise.resolve()
    }
    let active: Promise<void>
    active = this.handle(request, response).finally(() => {
      this.activeHandlers.delete(active)
    })
    this.activeHandlers.add(active)
    return active
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const body = await readBoundedBody(request, this.controller.signal)
      await this.ctx.autopilotReconciliation.acceptIngress(
        {
          method: request.method ?? '',
          headers: rawHeaders(request),
          body,
        },
        this.controller.signal,
      )
      writeResponse(response, 204)
    } catch (error) {
      if (response.destroyed || response.writableEnded) return
      const { status, retryAfterSeconds } = httpFailure(error)
      writeResponse(response, status, retryAfterSeconds)
    }
  }
}

async function readBoundedBody(request: IncomingMessage, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted()
  const declared = request.headers['content-length']
  if (declared !== undefined) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0) throw new TrackerProviderError('invalid-response', 'invalid body')
    if (length > MAX_INGRESS_BODY_BYTES) throw new PayloadTooLargeError()
  }
  const chunks: Uint8Array[] = []
  let total = 0
  const abort = () => {
    request.destroy(signal.reason instanceof Error ? signal.reason : new Error('tracker ingress body read was aborted'))
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    for await (const chunk of request) {
      signal.throwIfAborted()
      const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk)
      total += bytes.byteLength
      if (total > MAX_INGRESS_BODY_BYTES) throw new PayloadTooLargeError()
      chunks.push(bytes)
    }
    signal.throwIfAborted()
  } finally {
    signal.removeEventListener('abort', abort)
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function rawHeaders(request: IncomingMessage): TrackerIngressHeader[] {
  const headers: TrackerIngressHeader[] = []
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]
    const value = request.rawHeaders[index + 1]
    if (name !== undefined && value !== undefined) headers.push({ name: name.toLowerCase(), value })
  }
  return headers
}

function httpFailure(error: unknown): { status: number; retryAfterSeconds?: number } {
  if (error instanceof PayloadTooLargeError) return { status: 413 }
  if (error instanceof AdmissionIngressError) {
    return error.code === 'queue-capacity' ? { status: 429, retryAfterSeconds: 1 } : { status: 503 }
  }
  if (error instanceof ReconciliationError) {
    return error.code === 'overloaded' ? { status: 429, retryAfterSeconds: 1 } : { status: 503 }
  }
  if (!(error instanceof TrackerProviderError)) return { status: 503 }
  switch (error.code) {
    case 'authentication':
      return { status: 401 }
    case 'permission':
      return { status: 403 }
    case 'invalid-response':
      return { status: 400 }
    case 'conflict':
    case 'ambiguous-acknowledgement':
      return { status: 409 }
    case 'rate-limit':
      return {
        status: 429,
        ...(error.retryAfterMs === undefined ? {} : { retryAfterSeconds: Math.ceil(error.retryAfterMs / 1000) }),
      }
    case 'timeout':
      return { status: 504 }
    case 'invalid-configuration':
    case 'not-found':
    case 'transient':
    case 'unsupported-capability':
    case 'provider-unavailable':
      return { status: 503 }
  }
}

function writeResponse(response: ServerResponse, status: number, retryAfterSeconds?: number): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, {
    'cache-control': 'no-store',
    ...(status === 204 ? {} : { 'content-type': 'text/plain; charset=utf-8' }),
    ...(retryAfterSeconds === undefined ? {} : { 'retry-after': String(retryAfterSeconds) }),
  })
  response.end(status === 204 ? undefined : status === 401 ? 'unauthorized' : 'webhook rejected')
}

export default Ingress
