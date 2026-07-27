import { describe, it, expect, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import { initDb } from './db/index.js'
import { buildStatePayload } from './state.js'

initDb()

// buildStatePayload 本身依赖较多状态（session/preset/emotion 等），这里只关心 embeddingReady
// 这一个字段是否正确复用 isEmbeddingReady（与 GET /embedding-ready 共用同一逻辑，见 EmbeddingProvider.ts）
describe('buildStatePayload — embeddingReady', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('AI 服务健康检查返回 embedding_loaded=true 时，embeddingReady 为 true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', embedding_loaded: true, ner_loaded: false }),
    }))

    const fastify = Fastify()
    fastify.decorate('config', {})
    const payload = await buildStatePayload(fastify)

    expect(payload.embeddingReady).toBe(true)
  })

  it('AI 服务健康检查返回 embedding_loaded=false 时，embeddingReady 为 false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', embedding_loaded: false, ner_loaded: false }),
    }))

    const fastify = Fastify()
    fastify.decorate('config', {})
    const payload = await buildStatePayload(fastify)

    expect(payload.embeddingReady).toBe(false)
  })

  it('AI 服务不可达时，embeddingReady 为 false，不向上抛出', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    const fastify = Fastify()
    fastify.decorate('config', {})
    const payload = await buildStatePayload(fastify)

    expect(payload.embeddingReady).toBe(false)
  })
})
