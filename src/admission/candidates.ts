import type { TrackerIssueSnapshot, TrackerProviderId, TrackerReader } from '../tracker.js'
import { TrackerProviderError } from '../tracker.js'
import { MAX_CANDIDATE_BYTES, MAX_CANDIDATES, textEncoder } from './constants.js'

export async function readEveryCandidate(
  reader: TrackerReader,
  providerId: TrackerProviderId,
  signal?: AbortSignal,
): Promise<TrackerIssueSnapshot[]> {
  const issues: TrackerIssueSnapshot[] = []
  const seenCursors = new Set<string>()
  let totalCandidateBytes = 0
  let cursor: string | undefined
  do {
    signal?.throwIfAborted()
    const page = await reader.readCandidates(cursor)
    totalCandidateBytes += textEncoder.encode(JSON.stringify(page)).byteLength
    if (issues.length + page.issues.length > MAX_CANDIDATES || totalCandidateBytes > MAX_CANDIDATE_BYTES) {
      throw new TrackerProviderError('invalid-response', `tracker provider "${providerId}" exceeded admission bounds`)
    }
    issues.push(...page.issues)
    cursor = page.nextCursor
    if (cursor !== undefined && (!seenCursors.add(cursor) || seenCursors.size > 1000)) {
      throw new Error(`tracker provider "${providerId}" returned a non-terminating cursor sequence`)
    }
  } while (cursor !== undefined)
  return issues
}
