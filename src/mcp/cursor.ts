import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { TrackerProviderError } from '../tracker.js'

const CURSOR_VERSION = 1
const MAX_CURSOR_BYTES = 4_096

export interface McpTraversalCursor {
  readonly vendorCursor: string
  readonly pagesRead: number
  readonly itemsRead: number
}

/** Create a generation-local authenticated codec for untrusted provider continuation cursors. */
export function createMcpTraversalCursorCodec(): {
  encode(state: McpTraversalCursor): string
  decode(value: string): McpTraversalCursor
} {
  const key = randomBytes(32)
  return {
    encode(state) {
      const payload = Buffer.from(JSON.stringify({ version: CURSOR_VERSION, ...state })).toString('base64url')
      const signature = createHmac('sha256', key).update(payload).digest('base64url')
      const cursor = `${payload}.${signature}`
      if (Buffer.byteLength(cursor) > MAX_CURSOR_BYTES) throw invalidCursor()
      return cursor
    },
    decode(value) {
      if (Buffer.byteLength(value) > MAX_CURSOR_BYTES) throw invalidCursor()
      const [payload, signature, extra] = value.split('.')
      if (payload === undefined || signature === undefined || extra !== undefined) throw invalidCursor()
      const expected = createHmac('sha256', key).update(payload).digest()
      let actual: Buffer
      try {
        actual = Buffer.from(signature, 'base64url')
      } catch {
        throw invalidCursor()
      }
      if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) throw invalidCursor()
      let parsed: unknown
      try {
        parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown
      } catch {
        throw invalidCursor()
      }
      if (typeof parsed !== 'object' || parsed === null) throw invalidCursor()
      const candidate = parsed as Record<string, unknown>
      if (
        candidate.version !== CURSOR_VERSION ||
        typeof candidate.vendorCursor !== 'string' ||
        candidate.vendorCursor.length === 0 ||
        candidate.vendorCursor.length > MAX_CURSOR_BYTES ||
        !positiveInteger(candidate.pagesRead) ||
        !nonNegativeInteger(candidate.itemsRead)
      ) {
        throw invalidCursor()
      }
      return {
        vendorCursor: candidate.vendorCursor,
        pagesRead: candidate.pagesRead,
        itemsRead: candidate.itemsRead,
      }
    },
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function invalidCursor(): TrackerProviderError {
  return new TrackerProviderError('invalid-response', 'MCP tracker candidate cursor was invalid')
}
