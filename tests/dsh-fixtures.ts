import { Context, type Fiber, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-agent-presets'
import Credentials, {
  type CredentialKey,
  type CredentialRecord,
  type CredentialRecordEntry,
  type CredentialRecordInfo,
  type CredentialRef,
} from '@deepseek-ai/dsh-credentials'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Settings, { type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { issuePreparedAgentComposition } from '../src/admission/composition-claim.js'
import type { AgentExecutionComposition } from '../src/admission.js'

export const FIXTURE_PROVIDER = 'dsh-autopilot-fixture'
export const FIXTURE_MODEL = 'controlled'
export const FIXTURE_PRESET = 'controlled-autopilot'
export const FIXTURE_AGENT_COMPOSITION: AgentExecutionComposition = {
  presetId: FIXTURE_PRESET,
  presetFingerprint: '35bff4faca5a08ddff07dfc89d7654dc4a15fb791ab1e4dfa31f4f9de51410bf',
  permission: {
    presetId: 'autopilot-unattended',
    sandbox: 'workspace-write',
    approval: 'never',
  },
  model: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
}

export function fixtureCompositionClaim() {
  return issuePreparedAgentComposition(FIXTURE_AGENT_COMPOSITION)
}

class ControlledAgentDefaultModel extends Service {
  selection: ModelSelection = { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL }

  constructor(ctx: Context) {
    super(ctx, 'agentDefaultModel')
  }

  currentSelection(): ModelSelection {
    return structuredClone(this.selection)
  }
}

class ControlledAgentPresets extends Service {
  defaultId = FIXTURE_PRESET
  content = 'controlled composition'
  readonly mounted: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'agentPresets')
  }

  async mount(agentCtx: Context, id = this.defaultId): Promise<{ id: string }> {
    this.mounted.push(id)
    // The controlled adapter cannot account for descendants; the production preset owns its own capability policy.
    agentCtx.tools.restrict({ allow: [] })
    return { id }
  }

  standingKeyFor(id = this.defaultId): Promise<object> {
    return Promise.resolve({ agentPreset: id })
  }

  readDocument(id: string): Promise<{ agentPreset: string; trust: 'system'; content: string }> {
    return Promise.resolve({ agentPreset: id, trust: 'system', content: this.content })
  }

  compositionInventory(): Promise<Array<{ id: string; trust: 'system'; isDefault: boolean; rows: readonly never[] }>> {
    return Promise.resolve(
      [...new Set([FIXTURE_PRESET, this.defaultId])].map((id) => ({
        id,
        trust: 'system' as const,
        isDefault: id === this.defaultId,
        rows: [],
      })),
    )
  }
}

class ControlledPermissionPresets extends Service {
  defaultPreset = 'autopilot-unattended'
  readonly applied: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'permissionPresets')
  }

  resolve(name: string) {
    if (name !== 'autopilot-unattended') throw new Error(`unknown controlled permission preset "${name}"`)
    return { sandbox: 'workspace-write' as const, approval: 'never' as const }
  }

  set(_session: object, name: string): void {
    this.resolve(name)
    this.applied.push(name)
  }
}

export class MemorySettings extends Settings {
  readonly writable = true
  private stored: Record<string, unknown>

  constructor(ctx: Context, options?: { document?: Record<string, unknown> }) {
    super(ctx)
    this.stored = structuredClone(options?.document ?? {})
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.stored))
  }

  protected persist(namespace: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.stored[String(namespace)] = structuredClone(section)
    return Promise.resolve()
  }
}

export class MemoryCredentials extends Credentials {
  readonly values = new Map<string, string>()
  readonly records = new Map<CredentialKey, CredentialRecord>()
  resolveCount = 0

  constructor(ctx: Context, initial: Record<string, string> = {}) {
    super(ctx)
    for (const [reference, value] of Object.entries(initial)) this.values.set(reference, value)
  }

  resolve(reference: CredentialRef): Promise<{ value: string; source: string } | undefined> {
    this.resolveCount += 1
    const value = this.values.get(reference)
    return Promise.resolve(value === undefined || value === '' ? undefined : { value, source: 'memory' })
  }

  describe(reference: CredentialRef): Promise<{ configured: boolean; source?: string; writable: boolean }> {
    const configured = (this.values.get(reference)?.length ?? 0) > 0
    return Promise.resolve({ configured, ...(configured ? { source: 'memory' } : {}), writable: true })
  }

  set(reference: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) return Promise.reject(new TypeError('credential value cannot be empty'))
    this.values.set(reference, value)
    return Promise.resolve()
  }

  unset(reference: CredentialRef): Promise<void> {
    this.values.delete(reference)
    return Promise.resolve()
  }

  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(structuredClone(this.records.get(key)))
  }

  describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const record = this.records.get(key)
    return Promise.resolve({
      configured: record !== undefined,
      ...(record === undefined ? {} : { kind: record.kind }),
      writable: true,
    })
  }

  listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([...this.records].map(([key, record]) => ({ key, kind: record.kind })))
  }

  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(structuredClone(this.records.get(key)))
    if (next !== undefined) this.records.set(key, structuredClone(next))
    return structuredClone(next ?? this.records.get(key))
  }

  deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(key)
    return Promise.resolve()
  }
}

const agentRegistryFibers = new WeakMap<Context, Fiber>()
const controlledModels = new WeakMap<Context, ControlledAgentDefaultModel>()
const controlledPresets = new WeakMap<Context, ControlledAgentPresets>()
const controlledPermissions = new WeakMap<Context, ControlledPermissionPresets>()

export async function mountHostServices(
  databasePath: string,
  settings: Record<string, unknown> = {},
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemorySettings, { document: settings })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: databasePath })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  return ctx
}

export async function mountExecutionHostServices(
  databasePath: string,
  sessionRoot: string,
  settings: Record<string, unknown> = {},
): Promise<Context> {
  const ctx = await mountHostServices(databasePath, settings)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ControlledAgentDefaultModel)
  await ctx.plugin(ControlledAgentPresets)
  await ctx.plugin(ControlledPermissionPresets)
  controlledModels.set(ctx, ctx.get('agentDefaultModel') as unknown as ControlledAgentDefaultModel)
  controlledPresets.set(ctx, ctx.get('agentPresets') as unknown as ControlledAgentPresets)
  controlledPermissions.set(ctx, ctx.get('permissionPresets') as unknown as ControlledPermissionPresets)
  agentRegistryFibers.set(ctx, await ctx.plugin(AgentRegistry))
  await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  return ctx
}

export function executionAgentRegistryFiber(ctx: Context): Fiber {
  const fiber = agentRegistryFibers.get(ctx)
  if (fiber === undefined) throw new Error('execution Agent registry is not mounted for this fixture Context')
  return fiber
}

export async function remountExecutionAgentRegistry(ctx: Context): Promise<Fiber> {
  const fiber = await ctx.plugin(AgentRegistry)
  agentRegistryFibers.set(ctx, fiber)
  return fiber
}

export function setFixtureAgentDefaults(ctx: Context, selection: ModelSelection, presetId = FIXTURE_PRESET): void {
  const model = controlledModels.get(ctx)
  const presets = controlledPresets.get(ctx)
  if (model === undefined || presets === undefined) throw new Error('controlled DSH composition is not mounted')
  model.selection = structuredClone(selection)
  presets.defaultId = presetId
}

export function mountedFixturePresets(ctx: Context): readonly string[] {
  const presets = controlledPresets.get(ctx)
  if (presets === undefined) throw new Error('controlled DSH preset service is not mounted')
  return presets.mounted
}

export function setFixturePresetContent(ctx: Context, content: string): void {
  const presets = controlledPresets.get(ctx)
  if (presets === undefined) throw new Error('controlled DSH preset service is not mounted')
  presets.content = content
}

export function appliedFixturePermissions(ctx: Context): readonly string[] {
  const permissions = controlledPermissions.get(ctx)
  if (permissions === undefined) throw new Error('controlled DSH permission service is not mounted')
  return permissions.applied
}

export function fixtureExecutionSettings(
  targetRepository: string,
  managedWorktreeRoot: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    executionMode: 'native',
    runUrlTemplate: 'https://autopilot.example.invalid/runs/{runId}',
    issueUrlTemplate: 'https://tracker.example.invalid/issues/{displayKey}',
    targetRepository,
    targetBaseBranch: 'main',
    managedWorktreeRoot,
    codeHostProvider: 'fixture-code-host',
    deploymentTokenCap: 100,
    perRunTokenCap: 60,
    runTokenAllowance: 60,
    ...overrides,
  }
}

export async function disposeContext(ctx: Context): Promise<void> {
  await ctx.fiber.dispose()
}

export class Deferred<T> {
  readonly promise: Promise<T>
  resolve!: (value: T) => void
  reject!: (reason?: unknown) => void

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
}
