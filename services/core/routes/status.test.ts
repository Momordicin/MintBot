import { describe, it, expect, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import { statusRoutes } from './status.js'

async function buildTestApp() {
  const fastify = Fastify()
  await fastify.register(statusRoutes)
  return fastify
}

describe('GET /ai-available', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('AI 服务 /health 身份匹配且 embedding_loaded=true 时，端点返回 { aiAvailable: true }', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', service: 'mintbot-ai', embedding_loaded: true, ner_loaded: false }),
    }))

    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'GET', url: '/ai-available' })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.payload)).toEqual({ aiAvailable: true })
  })

  it('AI 服务 /health 身份匹配但 embedding_loaded=false 时，端点仍返回 { aiAvailable: true }', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', service: 'mintbot-ai', embedding_loaded: false, ner_loaded: false }),
    }))

    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'GET', url: '/ai-available' })

    expect(JSON.parse(response.payload)).toEqual({ aiAvailable: true })
  })

  it('AI 服务不可达（fetch 抛出）时，端点仍返回 200 { aiAvailable: false }，不向上抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'GET', url: '/ai-available' })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.payload)).toEqual({ aiAvailable: false })
  })

  it('AI 服务 /health 返回非 2xx 时，端点返回 { aiAvailable: false }', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }))

    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'GET', url: '/ai-available' })

    expect(JSON.parse(response.payload)).toEqual({ aiAvailable: false })
  })

  it('回归用例：端口被外来服务占用（如 AnkiConnect）响应 HTTP 200 但缺少身份标识时，端点返回 { aiAvailable: false }', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ apiVersion: 'AnkiConnect v.6' }),
    }))

    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'GET', url: '/ai-available' })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.payload)).toEqual({ aiAvailable: false })
  })
})
