import { type Context, Service } from '@deepseek-ai/cordis'
import { ZodError } from 'zod'
import { GenerationRegistry, type ProviderGeneration } from '../providers/generation-registry.js'
import {
  CODE_HOST_INTERFACE_VERSION,
  type CodeHostBinding,
  type CodeHostProvider,
  CodeHostProviderError,
  type CodeHostProviderId,
  type CodeHostProviderRequest,
  type CodeHostPublication,
  type CodeHostPublisher,
  codeHostCapabilities,
} from './model.js'
import { pullRequestReceiptSchema, reconciliationSchema } from './validation.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    codeHost: CodeHost
  }
}

/** Generation-fenced normalized code-host seam used only by the Host publication owner. */
export class CodeHost extends Service {
  private readonly providers = new GenerationRegistry<CodeHostProviderId, CodeHostProvider>()
  private readonly bindings = new Map<CodeHostProviderId, CodeHostBinding>()

  constructor(ctx: Context) {
    super(ctx, 'codeHost')
  }

  /** Register one complete provider generation; the disposer fences new calls, aborts active work, and drains it. */
  register(provider: CodeHostProvider): () => Promise<void> {
    if (provider.interfaceVersion !== CODE_HOST_INTERFACE_VERSION) {
      throw new TypeError(
        `code-host provider "${provider.id}" uses interface version ${String(provider.interfaceVersion)}; expected ${String(CODE_HOST_INTERFACE_VERSION)}`,
      )
    }
    if (this.providers.has(provider.id)) throw new Error(`code-host provider "${provider.id}" is already registered`)
    const missing = codeHostCapabilities.filter((capability) => !provider.capabilities.includes(capability))
    if (missing.length > 0) {
      throw new TypeError(`code-host provider "${provider.id}" is missing capabilities: ${missing.join(', ')}`)
    }
    return this.providers.register(provider.id, provider)
  }

  /** Register the single provider-owned target snapshot used for future execution claims. */
  registerBinding(binding: CodeHostBinding): () => void {
    if (this.bindings.has(binding.providerId)) {
      throw new Error(`code-host binding "${binding.providerId}" is already registered`)
    }
    const retained = structuredClone(binding)
    this.bindings.set(binding.providerId, retained)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.bindings.get(binding.providerId) === retained) this.bindings.delete(binding.providerId)
    }
  }

  /** Return the current provider-owned target, or fail before a run can snapshot an unavailable binding. */
  binding(id: CodeHostProviderId): CodeHostBinding {
    const binding = this.bindings.get(id)
    if (binding === undefined) {
      throw new CodeHostProviderError('provider-unavailable', `code-host binding "${id}" is unavailable`)
    }
    return structuredClone(binding)
  }

  /** Retain one provider generation for a publication sequence; provider withdrawal fences every late result. */
  async withProvider<T>(id: CodeHostProviderId, operation: (publisher: CodeHostPublisher) => Promise<T>): Promise<T> {
    const registered = this.providers.require(
      id,
      () => new CodeHostProviderError('provider-unavailable', `code-host provider "${id}" is unavailable`),
    )
    const publisher: CodeHostPublisher = {
      reconcile: (publication, signal) =>
        this.invoke(registered, 'reconcile', publication, signal, reconciliationSchema.parse),
      createBranch: (publication, signal) => this.invoke(registered, 'createBranch', publication, signal),
      publishChanges: (publication, signal) => this.invoke(registered, 'publishChanges', publication, signal),
      createPullRequest: (publication, signal) =>
        this.invoke(registered, 'createPullRequest', publication, signal, pullRequestReceiptSchema.parse),
    }
    return await this.providers.retain(registered, () => operation(publisher))
  }

  private async invoke<T>(
    registered: ProviderGeneration<CodeHostProvider>,
    operation: keyof Pick<CodeHostProvider, 'reconcile' | 'createBranch' | 'publishChanges' | 'createPullRequest'>,
    publication: CodeHostPublication,
    callerSignal?: AbortSignal,
    validate?: (value: unknown) => T,
  ): Promise<T> {
    callerSignal?.throwIfAborted()
    const request: CodeHostProviderRequest = {
      publication: structuredClone(publication),
      signal: this.providers.signal(registered, callerSignal),
    }
    try {
      const value = await registered.provider[operation](request)
      this.providers.assertCurrent(registered, () => withdrawn(registered.provider.id, operation))
      callerSignal?.throwIfAborted()
      return validate === undefined ? (value as T) : validate(value)
    } catch (error) {
      if (!registered.accepting) throw withdrawn(registered.provider.id, operation)
      callerSignal?.throwIfAborted()
      if (error instanceof CodeHostProviderError) throw error
      if (error instanceof ZodError) {
        throw new CodeHostProviderError(
          'invalid-response',
          `code-host provider "${registered.provider.id}" returned an invalid ${operation} result`,
        )
      }
      throw new CodeHostProviderError('transient', `code-host provider "${registered.provider.id}" failed ${operation}`)
    }
  }
}

function withdrawn(
  id: CodeHostProviderId,
  operation: keyof Pick<CodeHostProvider, 'reconcile' | 'createBranch' | 'publishChanges' | 'createPullRequest'>,
): CodeHostProviderError {
  return new CodeHostProviderError(
    operation === 'reconcile' ? 'provider-unavailable' : 'ambiguous-acknowledgement',
    `code-host provider "${id}" was withdrawn`,
  )
}

export default CodeHost
