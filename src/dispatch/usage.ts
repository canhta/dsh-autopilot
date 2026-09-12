import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type {
  AgentExecutionComposition,
  ImplementingRun,
  PausedActiveRun,
  PausingRun,
  RunUsageSettlement,
} from '../admission.js'

export interface UsageRecorder {
  readonly usage: TokenUsage[]
  requests: number
  uncertainty?: string
}

export function registerUsageRecorder(
  agentCtx: Context,
  run: ImplementingRun | PausingRun | PausedActiveRun,
  composition: AgentExecutionComposition,
  recorder: UsageRecorder,
): void {
  agentCtx.on('llm/stream', async function* (options: GenerateOptions, next): AsyncIterable<StreamChunk> {
    recorder.requests += 1
    if (
      options.provider !== composition.model.provider ||
      options.model !== composition.model.model ||
      options.reasoningEffort !== composition.model.reasoningEffort ||
      options.sessionId !== run.execution.sessionId
    ) {
      recorder.uncertainty = 'a model request escaped the claimed provider, model, reasoning, or session identity'
    }
    let usageChunks = 0
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') {
          usageChunks += 1
          if (validTokenUsage(chunk.usage)) recorder.usage.push(structuredClone(chunk.usage))
          else recorder.uncertainty = 'the model provider returned invalid token usage'
        }
        yield chunk
      }
    } finally {
      if (usageChunks !== 1) recorder.uncertainty = 'a model request did not return exactly one usage record'
    }
  })
}

export function usageSettlement(recorder: UsageRecorder): RunUsageSettlement {
  if (recorder.uncertainty !== undefined) return { kind: 'uncertain', reason: recorder.uncertainty }
  if (recorder.usage.length !== recorder.requests) {
    return { kind: 'uncertain', reason: 'provider usage records did not match the number of model requests' }
  }
  const tokens = recorder.usage.reduce(
    (total, current) =>
      total +
      current.inputTokens +
      current.outputTokens +
      (current.cacheReadTokens ?? 0) +
      (current.cacheWriteTokens ?? 0),
    0,
  )
  return Number.isSafeInteger(tokens)
    ? { kind: 'known', tokens }
    : { kind: 'uncertain', reason: 'provider usage overflowed the safe integer range' }
}

function validTokenUsage(usage: TokenUsage): boolean {
  return [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  )
}
