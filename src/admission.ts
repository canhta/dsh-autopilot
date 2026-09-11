import { createHash } from 'node:crypto'
import { type Context, Service } from '@deepseek-ai/cordis'
import { type SettingsScope, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import {
  type ReadinessGeneration,
  readinessGeneration,
  type TrackerBindingId,
  type TrackerComment,
  type TrackerCommentId,
  type TrackerIssueId,
  type TrackerIssueSnapshot,
  TrackerProviderError,
  type TrackerProviderId,
  type TrackerReader,
  trackerBindingId,
  trackerCommentId,
  trackerIssueId,
  trackerProviderId,
} from './tracker.js'

const MAX_INGRESS_RECEIPTS = 2048
const MAX_STATE_BYTES = 4 * 1024 * 1024
const MAX_SUMMARY_BYTES = 2048
const MAX_BRIEF_BYTES = 32 * 1024
const MAX_CANDIDATES = 1000
const MAX_CANDIDATE_BYTES = 16 * 1024 * 1024
const STATE_KEY = 'primary' as const
const textEncoder = new TextEncoder()
const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/

declare const runIdBrand: unique symbol
export type RunId = string & { readonly [runIdBrand]: true }

export type AdmissionSource = 'manual' | 'scheduled' | 'startup' | 'webhook'

export interface ReconcileRequest {
  source: AdmissionSource
  deliveryId?: string
}

export type AdmissionRejectionReason =
  | 'missing-brief'
  | 'ambiguous-brief'
  | 'invalid-brief'
  | 'brief-too-large'
  | 'summary-too-large'
  | 'not-ready'
  | 'dependencies-incomplete'
  | 'dependency-unknown'
  | 'human-readiness-required'

export type AdmissionDecision =
  | { displayKey: string; outcome: 'queued' | 'duplicate' }
  | { displayKey: string; outcome: 'deferred'; reason: 'queue-capacity' }
  | { displayKey: string; outcome: 'rejected'; reason: AdmissionRejectionReason }

export interface AgentBriefSnapshot {
  readonly commentId: TrackerCommentId
  readonly updatedAt: string
  readonly digest: string
  readonly content: string
}

export interface QueuedRun {
  readonly runId: RunId
  readonly providerId: TrackerProviderId
  readonly bindingId: TrackerBindingId
  readonly issueId: TrackerIssueId
  readonly displayKey: string
  readonly summary: string
  readonly priorityRank: number
  readonly readinessGeneration: ReadinessGeneration
  readonly brief: AgentBriefSnapshot
  readonly state: 'queued'
  readonly queuedAt: string
  readonly queueSequence: number
}

export interface AdmissionSnapshot {
  revision: number
  runs: readonly QueuedRun[]
  acceptedIngress: readonly string[]
}

export interface ReconcileResult extends AdmissionSnapshot {
  decisions: readonly AdmissionDecision[]
}

interface AdmissionSettings {
  trackerProvider: string
  maxQueued: number
  maxBriefBytes: number
}

const admissionSettingsSchema: s<AdmissionSettings> = s.object({
  trackerProvider: s.string().default('jira'),
  maxQueued: s.number().min(1).max(100).default(20),
  maxBriefBytes: s
    .number()
    .min(1024)
    .max(32 * 1024)
    .default(32 * 1024),
})

const briefSchema = z.object({
  commentId: z.string().min(1).max(256).transform(trackerCommentId),
  updatedAt: z.iso.datetime({ offset: true }),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  content: z.string().refine((value) => textEncoder.encode(value).byteLength <= MAX_BRIEF_BYTES, {
    error: `Brief content must not exceed ${String(MAX_BRIEF_BYTES)} UTF-8 bytes`,
  }),
})

const runSchema = z.object({
  runId: z
    .string()
    .regex(/^run_[a-f0-9]{32}$/)
    .transform((value) => value as RunId),
  providerId: z.string().transform(trackerProviderId),
  bindingId: z.string().transform(trackerBindingId),
  issueId: z.string().transform(trackerIssueId),
  displayKey: z.string().min(1).max(256),
  summary: z.string().refine((value) => textEncoder.encode(value).byteLength <= MAX_SUMMARY_BYTES, {
    error: `summary must not exceed ${String(MAX_SUMMARY_BYTES)} UTF-8 bytes`,
  }),
  priorityRank: z.number().int().nonnegative(),
  readinessGeneration: z.string().transform(readinessGeneration),
  brief: briefSchema,
  state: z.literal('queued'),
  queuedAt: z.iso.datetime({ offset: true }),
  queueSequence: z.number().int().positive(),
})

const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    nextSequence: z.number().int().positive(),
    runs: z.array(runSchema).max(100),
    acceptedIngress: z.array(z.string().min(1).max(512).regex(ID_PATTERN)).max(MAX_INGRESS_RECEIPTS),
  })
  .superRefine((value, context) => {
    const identities = value.runs.map(runIdentityFromRun)
    const sequences = value.runs.map((run) => run.queueSequence)
    const addIntegrityIssue = (message: string): void => {
      context.addIssue({ code: 'custom', message })
    }
    if (new Set(value.runs.map((run) => run.runId)).size !== value.runs.length) {
      addIntegrityIssue('run ids must be unique')
    }
    if (new Set(sequences).size !== sequences.length) addIntegrityIssue('queue sequences must be unique')
    if (new Set(value.acceptedIngress).size !== value.acceptedIngress.length) {
      addIntegrityIssue('accepted ingress ids must be unique')
    }
    if (value.runs.some((run, index) => run.runId !== runId(identities[index] ?? ''))) {
      addIntegrityIssue('run ids must match their durable identities')
    }
    if (value.runs.some((run) => createHash('sha256').update(run.brief.content).digest('hex') !== run.brief.digest)) {
      addIntegrityIssue('Brief digests must match retained content')
    }
    if (sequences.length > 0 && value.nextSequence <= Math.max(...sequences)) {
      addIntegrityIssue('next queue sequence must follow every retained run')
    }
  })
  .refine((value) => textEncoder.encode(JSON.stringify(value)).byteLength <= MAX_STATE_BYTES, {
    error: `admission state must not exceed ${String(MAX_STATE_BYTES)} UTF-8 bytes`,
  })

type AdmissionState = z.infer<typeof stateSchema>

const admissionDomainSpec = defineDomain({
  name: 'autopilot_admission',
  version: 1,
  tables: {
    state: domainTable<typeof STATE_KEY, AdmissionState>(stateSchema),
  },
})

interface EligibleIssue {
  issue: TrackerIssueSnapshot & { readiness: Extract<TrackerIssueSnapshot['readiness'], { kind: 'transition' }> }
  brief: AgentBriefSnapshot
}

const initialState: AdmissionState = {
  schemaVersion: 1,
  revision: 0,
  nextSequence: 1,
  runs: [],
  acceptedIngress: [],
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    admission: Admission
  }
}

export class Admission extends Service {
  static readonly inject = ['tracker', 'settings', 'storageDomain']

  private settings?: SettingsScope<AdmissionSettings>
  private state?: KvTable<typeof STATE_KEY, AdmissionState>

  constructor(ctx: Context) {
    super(ctx, 'admission')
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    this.settings = this.ctx.settings.register(settingsNamespace('dsh-autopilot'), admissionSettingsSchema, {
      validate: (value) => {
        trackerProviderId(value.trackerProvider)
        if (!Number.isInteger(value.maxQueued) || !Number.isInteger(value.maxBriefBytes)) {
          throw new TypeError('admission limits must be integers')
        }
      },
    })
    const domain = await this.ctx.storageDomain.open(admissionDomainSpec)
    yield () => domain.close()
    this.state = domain.table('state')
    if (this.state.get(STATE_KEY) === undefined) {
      await this.state.put(STATE_KEY, initialState)
    }
  }

  /**
   * Return a detached, priority-ordered view of the initialized durable queue.
   * Throws if the service has not finished initialization; it performs no I/O and has no cancellation point.
   */
  snapshot(): AdmissionSnapshot {
    const current = this.currentState()
    return snapshotOf(current)
  }

  /**
   * Read the selected tracker provider and atomically admit every currently eligible issue.
   * Provider, validation, capacity, or durable-write failures reject without advancing admission state. Provider
   * withdrawal cancels its owned reads; callers cannot independently cancel this operation in interface version 1.
   */
  async reconcile(request: ReconcileRequest): Promise<ReconcileResult> {
    validateRequest(request)
    const settings = this.currentSettings()
    const providerId = trackerProviderId(settings.trackerProvider)
    if (request.deliveryId !== undefined && !request.deliveryId.startsWith(`${providerId}:`)) {
      throw new TypeError(`delivery id must be qualified by tracker provider "${providerId}"`)
    }
    const beforeRead = this.currentState()
    if (request.deliveryId !== undefined && beforeRead.acceptedIngress.includes(request.deliveryId)) {
      return { ...snapshotOf(beforeRead), decisions: [] }
    }
    return this.ctx.tracker.withProvider(providerId, async (reader) => {
      const candidates = await this.readEveryCandidate(reader, providerId)
      const evaluated = candidates.map((issue) => evaluateIssue(issue, settings.maxBriefBytes))
      const eligible = evaluated
        .map((evaluation, index) => ({ evaluation, index }))
        .filter((entry): entry is { evaluation: EligibleIssue; index: number } => !('reason' in entry.evaluation))
        .sort(
          (left, right) =>
            left.evaluation.issue.priorityRank - right.evaluation.issue.priorityRank ||
            runIdentity(providerId, left.evaluation.issue).localeCompare(
              runIdentity(providerId, right.evaluation.issue),
            ),
        )
      const state = this.currentTable()
      let decisions: AdmissionDecision[] = []
      const committed = await state.update(STATE_KEY, (current) => {
        if (request.deliveryId !== undefined && current.acceptedIngress.includes(request.deliveryId)) {
          decisions = []
          return current
        }
        const next = structuredClone(current)
        const indexedDecisions: Array<AdmissionDecision | undefined> = evaluated.map((evaluation) => {
          if ('reason' in evaluation) {
            return { displayKey: evaluation.displayKey, outcome: 'rejected', reason: evaluation.reason }
          }
          return undefined
        })
        for (const { evaluation, index } of eligible) {
          const issue = evaluation.issue
          const identity = runIdentity(providerId, issue)
          if (next.runs.some((run) => runIdentityFromRun(run) === identity)) {
            indexedDecisions[index] = { displayKey: issue.displayKey, outcome: 'duplicate' }
            continue
          }
          if (next.runs.length >= settings.maxQueued) {
            indexedDecisions[index] = {
              displayKey: issue.displayKey,
              outcome: 'deferred',
              reason: 'queue-capacity',
            }
            continue
          }

          const run: QueuedRun = {
            runId: runId(identity),
            providerId,
            bindingId: issue.bindingId,
            issueId: issue.issueId,
            displayKey: issue.displayKey,
            summary: issue.summary,
            priorityRank: issue.priorityRank,
            readinessGeneration: issue.readiness.generation,
            brief: evaluation.brief,
            state: 'queued',
            queuedAt: new Date().toISOString(),
            queueSequence: next.nextSequence,
          }
          next.runs.push(run)
          next.nextSequence += 1
          indexedDecisions[index] = { displayKey: issue.displayKey, outcome: 'queued' }
        }
        decisions = indexedDecisions.filter((decision) => decision !== undefined)

        if (request.deliveryId !== undefined) {
          next.acceptedIngress.push(request.deliveryId)
          if (next.acceptedIngress.length > MAX_INGRESS_RECEIPTS) next.acceptedIngress.shift()
        }
        next.revision += 1
        const parsed = stateSchema.parse(next)
        assertStateSize(parsed)
        return parsed
      })

      return { ...snapshotOf(committed), decisions }
    })
  }

  private async readEveryCandidate(
    reader: TrackerReader,
    providerId: TrackerProviderId,
  ): Promise<TrackerIssueSnapshot[]> {
    const issues: TrackerIssueSnapshot[] = []
    const seenCursors = new Set<string>()
    let totalCandidateBytes = 0
    let cursor: string | undefined
    do {
      const page = await reader.readCandidates(cursor)
      const retainedBytes = textEncoder.encode(JSON.stringify(page)).byteLength
      totalCandidateBytes += retainedBytes
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

  private currentSettings(): AdmissionSettings {
    if (this.settings === undefined) throw new Error('admission service is not initialized')
    return this.settings.get()
  }

  private currentTable(): KvTable<typeof STATE_KEY, AdmissionState> {
    if (this.state === undefined) throw new Error('admission service is not initialized')
    return this.state
  }

  private currentState(): AdmissionState {
    const current = this.currentTable().get(STATE_KEY)
    if (current === undefined) throw new Error('admission state record is missing')
    return current
  }
}

function evaluateIssue(
  issue: TrackerIssueSnapshot,
  maxBriefBytes: number,
): EligibleIssue | { displayKey: string; reason: AdmissionRejectionReason } {
  if (textEncoder.encode(issue.summary).byteLength > MAX_SUMMARY_BYTES) {
    return { displayKey: issue.displayKey, reason: 'summary-too-large' }
  }
  if (!issue.isReady) return { displayKey: issue.displayKey, reason: 'not-ready' }
  const designated = issue.comments.filter(isDesignatedBrief)
  if (designated.length === 0) return { displayKey: issue.displayKey, reason: 'missing-brief' }
  if (designated.length > 1) return { displayKey: issue.displayKey, reason: 'ambiguous-brief' }
  const comment = designated[0]
  if (comment === undefined) return { displayKey: issue.displayKey, reason: 'missing-brief' }
  if (textEncoder.encode(comment.body).byteLength > maxBriefBytes) {
    return { displayKey: issue.displayKey, reason: 'brief-too-large' }
  }
  if (!hasRequiredBriefSections(comment.body)) {
    return { displayKey: issue.displayKey, reason: 'invalid-brief' }
  }
  if (issue.dependencies.some((dependency) => dependency.state === 'unknown')) {
    return { displayKey: issue.displayKey, reason: 'dependency-unknown' }
  }
  if (issue.dependencies.some((dependency) => dependency.state === 'not-completed')) {
    return { displayKey: issue.displayKey, reason: 'dependencies-incomplete' }
  }
  if (issue.readiness.kind !== 'transition' || issue.readiness.actorKind !== 'human') {
    return { displayKey: issue.displayKey, reason: 'human-readiness-required' }
  }
  if (Date.parse(issue.readiness.occurredAt) < Date.parse(comment.updatedAt)) {
    return { displayKey: issue.displayKey, reason: 'human-readiness-required' }
  }
  return {
    issue: issue as EligibleIssue['issue'],
    brief: {
      commentId: comment.id,
      updatedAt: comment.updatedAt,
      digest: createHash('sha256').update(comment.body).digest('hex'),
      content: comment.body,
    },
  }
}

function isDesignatedBrief(comment: TrackerComment): boolean {
  return /^#\s+Agent Brief\s*$/im.test(comment.body) && /^dsh-autopilot:brief:v1\s*$/im.test(comment.body)
}

function hasRequiredBriefSections(body: string): boolean {
  const matches = [...body.matchAll(/^##\s+(.+?)\s*$/gm)]
  const sections = new Map<string, string>()
  for (const [index, match] of matches.entries()) {
    const rawHeading = match[1]
    if (rawHeading === undefined || match.index === undefined) return false
    const heading = rawHeading.trim().toLocaleLowerCase('en-US')
    const contentStart = match.index + match[0].length
    const contentEnd = matches[index + 1]?.index ?? body.length
    sections.set(heading, body.slice(contentStart, contentEnd).trim())
  }
  return ['objective', 'in scope', 'acceptance criteria', 'constraints', 'context'].every(
    (heading) => (sections.get(heading)?.length ?? 0) > 0,
  )
}

function runIdentity(providerId: TrackerProviderId, issue: EligibleIssue['issue']): string {
  if (issue.readiness.kind !== 'transition') throw new Error('eligible issue lost readiness transition')
  return JSON.stringify([providerId, issue.bindingId, issue.issueId, issue.readiness.generation])
}

function runIdentityFromRun(run: QueuedRun): string {
  return JSON.stringify([run.providerId, run.bindingId, run.issueId, run.readinessGeneration])
}

function runId(identity: string): RunId {
  return `run_${createHash('sha256').update(identity).digest('hex').slice(0, 32)}` as RunId
}

function snapshotOf(state: AdmissionState): AdmissionSnapshot {
  return {
    revision: state.revision,
    runs: structuredClone(state.runs).sort(
      (left, right) =>
        left.priorityRank - right.priorityRank ||
        left.queueSequence - right.queueSequence ||
        left.displayKey.localeCompare(right.displayKey),
    ),
    acceptedIngress: [...state.acceptedIngress],
  }
}

function assertStateSize(state: AdmissionState): void {
  if (textEncoder.encode(JSON.stringify(state)).byteLength > MAX_STATE_BYTES) {
    throw new RangeError(`admission state exceeds ${String(MAX_STATE_BYTES)} bytes`)
  }
}

function validateRequest(request: ReconcileRequest): void {
  if (!['manual', 'scheduled', 'startup', 'webhook'].includes(request.source)) {
    throw new TypeError(`unsupported admission source "${String(request.source)}"`)
  }
  if (request.source === 'webhook' && request.deliveryId === undefined) {
    throw new TypeError('webhook reconciliation requires a provider-qualified delivery id')
  }
  if (request.deliveryId !== undefined && (request.deliveryId.length > 512 || !ID_PATTERN.test(request.deliveryId))) {
    throw new TypeError('delivery id must be provider-qualified and contain only stable id characters')
  }
}

export default Admission
