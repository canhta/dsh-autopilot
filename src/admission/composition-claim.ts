import type { AgentExecutionComposition } from './model.js'

declare const preparedCompositionBrand: unique symbol

/** One-shot proof that Dispatch resolved this composition through the live DSH services. */
export interface PreparedAgentComposition {
  readonly [preparedCompositionBrand]: true
  readonly composition: AgentExecutionComposition
}

const liveClaims = new WeakSet<object>()

export function issuePreparedAgentComposition(composition: AgentExecutionComposition): PreparedAgentComposition {
  const claim = { composition: structuredClone(composition) } as PreparedAgentComposition
  liveClaims.add(claim)
  return claim
}

export function consumePreparedAgentComposition(claim: PreparedAgentComposition): AgentExecutionComposition {
  if (!liveClaims.delete(claim)) {
    throw new Error('agent composition was not prepared by the live DSH composition authority')
  }
  return structuredClone(claim.composition)
}
