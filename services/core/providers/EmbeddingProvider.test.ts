import { describe, it, expect, afterEach, vi } from 'vitest'
import { BGEProvider } from './EmbeddingProvider.js'
import { getLastActivityAt } from './aiActivity.js'

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

describe('BGEProvider — 共享活动追踪（aiActivity）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('embedBatch 在发起 fetch 之前就记录了一次活动', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ embeddings: [[1, 2, 3]] }),
    })))

    const before = Date.now()
    const provider = new BGEProvider()
    await provider.embedBatch(['hello'])

    expect(getLastActivityAt()).toBeGreaterThanOrEqual(before)
  })

  it('embed（委托给 embedBatch）同样会记录活动', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ embeddings: [[1, 2, 3]] }),
    })))

    const before = Date.now()
    const provider = new BGEProvider()
    await provider.embed('hello')

    expect(getLastActivityAt()).toBeGreaterThanOrEqual(before)
  })
})

describe('BGEProvider.unload', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POST {baseUrl}/embed/unload，返回响应体里的 unloaded 布尔值', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ unloaded: true }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new BGEProvider()
    const result = await provider.unload()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8765/embed/unload')
    expect(init.method).toBe('POST')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(result).toBe(true)
  })

  it('响应体 unloaded 为 false 时（如模型仍在使用中被拒绝）原样返回', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ unloaded: false }),
    }))

    const provider = new BGEProvider()
    expect(await provider.unload()).toBe(false)
  })

  it('响应非 ok 时抛出 [Embedding] HTTP {status} 错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))

    const provider = new BGEProvider()
    await expect(provider.unload()).rejects.toThrow('[Embedding] HTTP 503')
  })
})
