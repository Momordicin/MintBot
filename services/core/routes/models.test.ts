import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { modelsRoutes } from './models.js'

// GET /models 只负责按 type 分发（ollama 走 listOllamaModels，其余两种走静态列表），
// mock 掉 config/index.js 与 providers/ollama.js，测试聚焦本文件自己的分发逻辑，
// 不依赖真实 config.json 或本机是否真的跑着 Ollama——同 routes/config.test.ts 的 mock 方式
const { getModelProviderConfigMock, listOllamaModelsMock } = vi.hoisted(() => ({
  getModelProviderConfigMock: vi.fn(),
  listOllamaModelsMock: vi.fn(),
}))

vi.mock('../config/index.js', () => ({
  getModelProviderConfig: getModelProviderConfigMock,
}))

vi.mock('../providers/ollama.js', () => ({
  listOllamaModels: listOllamaModelsMock,
  getOllamaBaseUrl: (baseUrl?: string) => baseUrl ?? 'http://localhost:11434',
}))

async function buildTestApp() {
  const fastify = Fastify()
  await fastify.register(modelsRoutes)
  return fastify
}

beforeEach(() => {
  getModelProviderConfigMock.mockReset()
  listOllamaModelsMock.mockReset()
  getModelProviderConfigMock.mockReturnValue({ type: 'anthropic' })
})

describe('GET /models', () => {
  it('type=ollama 时调用 listOllamaModels，返回其结果', async () => {
    listOllamaModelsMock.mockResolvedValue(['qwen3', 'llama3'])
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/models?type=ollama' })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.payload)).toEqual({ models: ['qwen3', 'llama3'] })
    expect(listOllamaModelsMock).toHaveBeenCalledTimes(1)
  })

  it('type=ollama 且 Ollama 未运行（listOllamaModels 返回空数组）时返回空列表而不报错', async () => {
    listOllamaModelsMock.mockResolvedValue([])
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/models?type=ollama' })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.payload)).toEqual({ models: [] })
  })

  it('type=anthropic 时返回静态列表，不调用 listOllamaModels', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/models?type=anthropic' })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(Array.isArray(body.models)).toBe(true)
    expect(body.models.length).toBeGreaterThan(0)
    expect(listOllamaModelsMock).not.toHaveBeenCalled()
  })

  it('type=openai 时返回静态列表', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/models?type=openai' })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(Array.isArray(body.models)).toBe(true)
    expect(body.models.length).toBeGreaterThan(0)
  })

  it('type=deepseek 时返回静态列表', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/models?type=deepseek' })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(Array.isArray(body.models)).toBe(true)
    expect(body.models.length).toBeGreaterThan(0)
    expect(listOllamaModelsMock).not.toHaveBeenCalled()
  })

  it('type 缺失或无效时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/models' })

    expect(response.statusCode).toBe(400)
    expect(JSON.parse(response.payload)).toHaveProperty('error')
  })
})
