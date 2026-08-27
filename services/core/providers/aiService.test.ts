import { describe, it, expect, afterEach, vi } from 'vitest'
import { isAiServiceRunning } from './aiService.js'

// isAiServiceRunning 只判断进程本身是否在跑（HTTP 是否可连、状态码是否 ok），
// 与 EmbeddingProvider.ts 的 isEmbeddingReady（判断模型是否已加载）是两回事，
// 这里只覆盖它自己的三种结果：成功、非 ok 响应、请求异常（含超时）
describe('isAiServiceRunning', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('响应 ok 时返回 true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    expect(await isAiServiceRunning('http://localhost:8765')).toBe(true)
  })

  it('响应非 ok 时返回 false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))

    expect(await isAiServiceRunning('http://localhost:8765')).toBe(false)
  })

  it('fetch 抛出异常（如超时）时返回 false，不向上抛出', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')))

    expect(await isAiServiceRunning('http://localhost:8765')).toBe(false)
  })
})
