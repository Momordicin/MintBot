import { describe, it, expect, afterEach, vi } from 'vitest'
import { BGEProvider } from './EmbeddingProvider.js'

// BGEProvider.embedBatch 的 signal 合并逻辑（AbortSignal.any([callerSignal, 5s超时])）
// 是这次修复的核心：调用方（/chat 请求）传入自己的 signal 时，外部 abort 应该立刻
// 取消底层 fetch，而不是等满固定的 5 秒超时。这里直接 mock global.fetch 验证。
describe('BGEProvider.embedBatch — 外部 signal 取消', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('传入外部 signal 时，外部 abort 会让底层 fetch 的 signal 立即一起 abort', async () => {
    const controller = new AbortController()
    let capturedSignal: AbortSignal | undefined
    let rejectFetch: (err: unknown) => void
    const fetchPromise = new Promise((_resolve, reject) => { rejectFetch = reject })

    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal
      capturedSignal.addEventListener('abort', () => {
        rejectFetch(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      })
      return fetchPromise
    }))

    const provider = new BGEProvider()
    const resultPromise = provider.embedBatch(['hello'], controller.signal)
    resultPromise.catch(() => {}) // 断言前先挂上，避免 unhandled rejection 警告

    // 等 fetch 真正被调用（拿到合并后的 signal）
    await new Promise(resolve => setImmediate(resolve))
    expect(capturedSignal?.aborted).toBe(false)

    controller.abort()

    await expect(resultPromise).rejects.toThrow()
    expect(capturedSignal?.aborted).toBe(true)
  })

  it('不传 signal 时保持原有行为不变：正常发起请求并返回结果', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ embeddings: [[1, 2, 3]] }),
    })))

    const provider = new BGEProvider()
    const result = await provider.embedBatch(['hello'])

    expect(result).toEqual([[1, 2, 3]])
  })
})
