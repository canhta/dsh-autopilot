import type { IncomingMessage, ServerResponse } from 'node:http'
import { type Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { type TrackerIngressHeader, TrackerProviderError } from '../tracker.js'

export const TRACKER_INGRESS_PATH = '/dsh-autopilot/tracker'
const MAX_INGRESS_BODY_BYTES = 256 * 1024

class PayloadTooLargeError extends Error {}

/** Adapt one bounded Host HTTP route to provider-authenticated durable reconciliation. */
export class Ingress extends Service {
  static readonly inject = ['reconciliation', 'webServer']

  constructor(ctx: Context) {
    super(ctx, 'autopilotIngress')
  }

  async *[Service.init](): AsyncGenerator<() => void, void, void> {
    const unregister = this.ctx.webServer.register({
      kind: 'exact',
      path: TRACKER_INGRESS_PATH,
      handler: (request, response) => this.handle(request, response),
    })
    yield unregister
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const body = await readBoundedBody(request)
      await this.ctx.reconciliation.acceptIngress({
        method: request.method ?? '',
        headers: rawHeaders(request),
        body,
      })
      response.writeHead(204, { 'cache-control': 'no-store' })
      response.end()
    } catch (error) {
      const { status, retryAfterSeconds } = httpFailure(error)
      response.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
        ...(retryAfterSeconds === undefined ? {} : { 'retry-after': String(retryAfterSeconds) }),
      })
      response.end(status === 401 ? 'unauthorized' : 'webhook rejected')
    }
  }
}

async function readBoundedBody(request: IncomingMessage): Promise<Uint8Array> {
  const declared = request.headers['content-length']
  if (declared !== undefined) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0) throw new TrackerProviderError('invalid-response', 'invalid body')
    if (length > MAX_INGRESS_BODY_BYTES) throw new PayloadTooLargeError()
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of request) {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk)
    total += bytes.byteLength
    if (total > MAX_INGRESS_BODY_BYTES) throw new PayloadTooLargeError()
    chunks.push(bytes)
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

export default Ingress
