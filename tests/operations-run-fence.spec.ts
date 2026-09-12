import { describe, expect, it } from 'vitest'
import { type RunId, RunOperationFence } from '../src/admission.js'
import { Deferred } from './dsh-fixtures.js'

describe('per-run operation fence', () => {
  it('holds lifecycle mutation behind cleanup and advances the observed generation', async () => {
    const fence = new RunOperationFence()
    const runId = 'run_11111111111111111111111111111111' as RunId
    const cleanupEntered = new Deferred<void>()
    const releaseCleanup = new Deferred<void>()
    const cleanup = fence.exclusive(runId, async () => {
      cleanupEntered.resolve()
      await releaseCleanup.promise
    })
    await cleanupEntered.promise
    const observedGeneration = fence.generation(runId)
    let lifecycleMutated = false
    const lifecycle = fence.mutate(runId, () => {
      lifecycleMutated = true
      return Promise.resolve()
    })

    await Promise.resolve()
    expect(lifecycleMutated).toBe(false)
    expect(fence.generation(runId)).toBe(observedGeneration)

    releaseCleanup.resolve()
    await Promise.all([cleanup, lifecycle])
    expect(lifecycleMutated).toBe(true)
    expect(fence.generation(runId)).toBe(observedGeneration + 1)
  })
})
