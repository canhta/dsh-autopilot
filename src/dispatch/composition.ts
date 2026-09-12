import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { Session } from '@deepseek-ai/dsh-session'
import { issuePreparedAgentComposition, type PreparedAgentComposition } from '../admission/composition-claim.js'
import type { AgentExecutionComposition, RunExecutionSnapshot } from '../admission.js'

export class AgentCompositionUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AgentCompositionUnavailableError'
  }
}

/** Resolve and validate the Host's effective DSH defaults before admission can consume a queued run. */
export async function prepareAgentComposition(ctx: Context): Promise<PreparedAgentComposition> {
  const selected = ctx.agentDefaultModel.currentSelection()
  const presetId = ctx.agentPresets.defaultId
  const permissionPresetId = ctx.permissionPresets.defaultPreset
  const permission = ctx.permissionPresets.resolve(permissionPresetId)
  if (permission.approval !== 'never' || permission.sandbox !== 'workspace-write') {
    throw new AgentCompositionUnavailableError(
      `permission preset "${permissionPresetId}" must enforce workspace-write with no interactive approval for unattended runs`,
    )
  }
  const composition: AgentExecutionComposition = {
    presetId,
    presetFingerprint: await presetFingerprint(ctx, presetId),
    permission: {
      presetId: permissionPresetId,
      sandbox: permission.sandbox,
      approval: permission.approval,
    },
    model: {
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: String(selected.reasoningEffort) }),
    },
  }
  await assertAgentCompositionAvailable(ctx, composition)
  return issuePreparedAgentComposition(composition)
}

/** Prove a retained composition still resolves to the exact DSH preset, model, and permission policy it captured. */
export async function assertAgentCompositionAvailable(
  ctx: Context,
  composition: AgentExecutionComposition,
): Promise<void> {
  try {
    const fingerprint = await presetFingerprint(ctx, composition.presetId)
    if (fingerprint !== composition.presetFingerprint) {
      throw new Error(`agent preset "${composition.presetId}" content changed after the run was admitted`)
    }
    const permission = ctx.permissionPresets.resolve(composition.permission.presetId)
    if (
      permission.approval !== composition.permission.approval ||
      permission.sandbox !== composition.permission.sandbox
    ) {
      throw new Error(`permission preset "${composition.permission.presetId}" changed after the run was admitted`)
    }
    const model = await ctx.llm.resolveModelInfo(composition.model.provider, composition.model.model)
    if (
      composition.model.reasoningEffort !== undefined &&
      model.reasoning !== undefined &&
      !model.reasoning.efforts.some((effort) => String(effort.id) === composition.model.reasoningEffort)
    ) {
      throw new Error(
        `model "${composition.model.provider}/${composition.model.model}" does not support reasoning effort "${composition.model.reasoningEffort}"`,
      )
    }
  } catch (error) {
    if (error instanceof AgentCompositionUnavailableError) throw error
    throw new AgentCompositionUnavailableError('the retained DSH agent composition is unavailable', { cause: error })
  }
}

/** Compose a native DSH Agent from the exact defaults captured when its run was claimed. */
export async function mountAgentComposition(
  ctx: Context,
  agentCtx: Context,
  composition: AgentExecutionComposition,
): Promise<void> {
  await assertAgentCompositionAvailable(ctx, composition)
  await ctx.agentPresets.mount(agentCtx, composition.presetId)
  await assertAgentCompositionAvailable(ctx, composition)
  const selection: ModelSelectionRef = { current: modelSelection(composition), assembled: undefined }
  installModelSelection(agentCtx, selection)
}

/** Apply the retained native DSH permission policy before the Agent receives any input. */
export function applyAgentPermission(ctx: Context, session: Session, composition: AgentExecutionComposition): void {
  ctx.permissionPresets.set(session, composition.permission.presetId)
}

export function requiredAgentComposition(execution: RunExecutionSnapshot): AgentExecutionComposition {
  if (execution.agent === undefined) {
    throw new AgentCompositionUnavailableError(
      'the retained run predates native DSH composition and cannot be resumed safely',
    )
  }
  return execution.agent
}

async function presetFingerprint(ctx: Context, presetId: string): Promise<string> {
  await ctx.agentPresets.standingKeyFor(presetId)
  const document = await ctx.agentPresets.readDocument(presetId)
  if (document.trust !== 'system') {
    throw new Error(`agent preset "${presetId}" must be system-trusted for unattended execution`)
  }
  const inventory = (await ctx.agentPresets.compositionInventory()).find((preset) => preset.id === presetId)
  if (inventory === undefined || inventory.broken !== undefined) {
    throw new Error(`agent preset "${presetId}" has no usable composition inventory`)
  }
  const descendantTools = new Set([
    '@deepseek-ai/dsh-tool-subagent',
    '@deepseek-ai/dsh-tool-workflow',
    '@deepseek-ai/dsh-tool-ralph',
  ])
  if (inventory.rows.some((row) => row.enabled !== false && descendantTools.has(row.moduleName))) {
    throw new Error(`agent preset "${presetId}" exposes delegation without run-owned descendant accounting`)
  }
  return createHash('sha256').update(document.content, 'utf8').digest('hex')
}

export function modelSelection(composition: AgentExecutionComposition): ModelSelection {
  return {
    provider: composition.model.provider,
    model: composition.model.model,
    ...(composition.model.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(composition.model.reasoningEffort) }),
  }
}
