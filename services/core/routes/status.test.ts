import { describe, it, expect, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import { statusRoutes } from './status.js'

async function buildTestApp() {
  const fastify = Fastify()
  await fastify.register(statusRoutes)
  return fastify
}

describe('GET /embedding-ready', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('AI 服务 /health 返回 embedding_loaded=true 时，端点返回 { embeddingReady: true }', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', embedding_loaded: true, ner_loaded: false }),
    }))

    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'GET', url: '/embedding-ready' })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.payload)).toEqual({ embeddingReady: true })
  })

  it('AI 服务 /health 返回 embedding_loaded=false 时，端点返回 { embeddingReady: false }', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', embedding_loaded: false, ner_loaded: false }),
    }))

    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'GET', url: '/embedding-ready' })

    expect(JSON.parse(response.payload)).toEqual({ embeddingReady: false })
  })

  it('AI 服务不可达（fetch 抛出）时，端点仍返回 200 { embeddingReady: false }，不向上抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'GET', url: '/embedding-ready' })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.payload)).toEqual({ embeddingReady: false })
  })
})
