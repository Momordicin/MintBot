import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { configRoutes } from './config.js'

// routes/config.ts 只负责路由层的校验 + 响应整形，实际的读写职责在 config/index.ts——
// mock 掉整个 config 模块，测试聚焦于本文件自己的行为（校验规则、key 脱敏、undefined/null
// 语义），不依赖真实 config.json
const {
  getModelProviderConfigMock,
  getRawBackgroundModelProviderConfigMock,
  updateModelProviderConfigMock,
  updateBackgroundModelProviderConfigMock,
} = vi.hoisted(() => ({
  getModelProviderConfigMock: vi.fn(),
  getRawBackgroundModelProviderConfigMock: vi.fn(),
  updateModelProviderConfigMock: vi.fn(),
  updateBackgroundModelProviderConfigMock: vi.fn(),
}))

vi.mock('../config/index.js', () => ({
  getModelProviderConfig: getModelProviderConfigMock,
  getRawBackgroundModelProviderConfig: getRawBackgroundModelProviderConfigMock,
  updateModelProviderConfig: updateModelProviderConfigMock,
  updateBackgroundModelProviderConfig: updateBackgroundModelProviderConfigMock,
}))

async function buildTestApp() {
  const fastify = Fastify()
  await fastify.register(configRoutes)
  return fastify
}

beforeEach(() => {
  getModelProviderConfigMock.mockReset()
  getRawBackgroundModelProviderConfigMock.mockReset()
  updateModelProviderConfigMock.mockReset()
  updateBackgroundModelProviderConfigMock.mockReset()
  getRawBackgroundModelProviderConfigMock.mockReturnValue(null)
})

describe('GET /config/model', () => {
  it('返回 hasAnthropicApiKey/hasOpenaiApiKey 布尔值，从不回显真实 key', async () => {
    getModelProviderConfigMock.mockReturnValue({
      type: 'anthropic',
      anthropicApiKey: 'sk-real-secret',
      modelName: 'claude-3',
    })
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/config/model' })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.modelProvider).toEqual({
      type: 'anthropic',
      modelName: 'claude-3',
      hasAnthropicApiKey: true,
      hasOpenaiApiKey: false,
    })
    expect(JSON.stringify(body)).not.toContain('sk-real-secret')
  })

  it('modelProvider 未配置（getModelProviderConfig 抛错）时不 500，返回 modelProvider: null', async () => {
    getModelProviderConfigMock.mockImplementation(() => {
      throw new Error('[Config] modelProvider is not configured')
    })
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/config/model' })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.modelProvider).toBeNull()
  })

  it('没有配置 backgroundModelProvider 覆盖时返回 null，而不是 fallback 之后的 modelProvider 值', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3' })
    getRawBackgroundModelProviderConfigMock.mockReturnValue(null)
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/config/model' })
    const body = JSON.parse(response.payload)

    expect(body.backgroundModelProvider).toBeNull()
  })

  it('配置了 backgroundModelProvider 覆盖时同样脱敏返回', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3' })
    getRawBackgroundModelProviderConfigMock.mockReturnValue({
      type: 'openai',
      openaiApiKey: 'sk-bg-secret',
      modelName: 'gpt-4o',
    })
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/config/model' })
    const body = JSON.parse(response.payload)

    expect(body.backgroundModelProvider).toEqual({
      type: 'openai',
      modelName: 'gpt-4o',
      hasAnthropicApiKey: false,
      hasOpenaiApiKey: true,
    })
  })
})

describe('PATCH /config/model — 校验', () => {
  it('type 不是合法枚举值时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/model',
      payload: { modelProvider: { type: 'not-a-real-type' } },
    })

    expect(response.statusCode).toBe(400)
    expect(updateModelProviderConfigMock).not.toHaveBeenCalled()
  })

  it('type: anthropic 但合并后缺 anthropicApiKey 时返回 400', async () => {
    getModelProviderConfigMock.mockImplementation(() => { throw new Error('not configured') })
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/model',
      payload: { modelProvider: { type: 'anthropic', modelName: 'claude-3' } },
    })

    expect(response.statusCode).toBe(400)
    expect(updateModelProviderConfigMock).not.toHaveBeenCalled()
  })

  it('type: anthropic 但合并后缺 modelName 时返回 400', async () => {
    getModelProviderConfigMock.mockImplementation(() => { throw new Error('not configured') })
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/model',
      payload: { modelProvider: { type: 'anthropic', anthropicApiKey: 'sk-1' } },
    })

    expect(response.statusCode).toBe(400)
  })

  it('type: openai 但合并后缺 openaiApiKey 时返回 400', async () => {
    getModelProviderConfigMock.mockImplementation(() => { throw new Error('not configured') })
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/model',
      payload: { modelProvider: { type: 'openai', modelName: 'gpt-4o' } },
    })

    expect(response.statusCode).toBe(400)
  })

  it('type: ollama 但合并后缺 ollamaModel 时返回 400', async () => {
    getModelProviderConfigMock.mockImplementation(() => { throw new Error('not configured') })
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/model',
      payload: { modelProvider: { type: 'ollama' } },
    })

    expect(response.statusCode).toBe(400)
  })

  it('合并已存的当前配置后满足必填字段时通过校验（partial 本身不含 modelName，但已存配置里有）', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'anthropic', anthropicApiKey: 'sk-old', modelName: 'claude-3' })
    updateModelProviderConfigMock.mockReturnValue({ type: 'anthropic', anthropicApiKey: 'sk-new', modelName: 'claude-3' })
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/model',
      payload: { modelProvider: { anthropicApiKey: 'sk-new' } },
    })

    expect(response.statusCode).toBe(200)
    expect(updateModelProviderConfigMock).toHaveBeenCalledWith({ anthropicApiKey: 'sk-new' })
  })

  it('backgroundModelProvider 非 null 时同样按对应 type 校验必填字段，不满足则 400', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3' })
    getRawBackgroundModelProviderConfigMock.mockReturnValue(null)
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/model',
      payload: { backgroundModelProvider: { type: 'anthropic' } },
    })

    expect(response.statusCode).toBe(400)
    expect(updateBackgroundModelProviderConfigMock).not.toHaveBeenCalled()
  })

  it('backgroundModelProvider: null 不需要满足必填字段校验（清除覆盖请求直接放行）', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3' })
    updateBackgroundModelProviderConfigMock.mockReturnValue(null)
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/model',
      payload: { backgroundModelProvider: null },
    })

    expect(response.statusCode).toBe(200)
    expect(updateBackgroundModelProviderConfigMock).toHaveBeenCalledWith(null)
  })
})

describe('PATCH /config/model — 成功路径', () => {
  it('modelProvider 校验通过后调用 updateModelProviderConfig，响应用返回值脱敏', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3' })
    updateModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'llama3' })
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/model',
      payload: { modelProvider: { ollamaModel: 'llama3' } },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(updateModelProviderConfigMock).toHaveBeenCalledWith({ ollamaModel: 'llama3' })
    expect(body.modelProvider).toEqual({
      type: 'ollama',
      ollamaModel: 'llama3',
      hasAnthropicApiKey: false,
      hasOpenaiApiKey: false,
    })
  })

  it('body 未带 modelProvider 时不调用 updateModelProviderConfig，响应仍返回当前值', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3' })
    getRawBackgroundModelProviderConfigMock.mockReturnValue(null)
    updateBackgroundModelProviderConfigMock.mockReturnValue({ type: 'anthropic', anthropicApiKey: 'sk-bg', modelName: 'claude-strong' })
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/model',
      payload: { backgroundModelProvider: { type: 'anthropic', anthropicApiKey: 'sk-bg', modelName: 'claude-strong' } },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(updateModelProviderConfigMock).not.toHaveBeenCalled()
    expect(body.modelProvider).toEqual({
      type: 'ollama',
      ollamaModel: 'qwen3',
      hasAnthropicApiKey: false,
      hasOpenaiApiKey: false,
    })
    expect(body.backgroundModelProvider).toEqual({
      type: 'anthropic',
      modelName: 'claude-strong',
      hasAnthropicApiKey: true,
      hasOpenaiApiKey: false,
    })
  })

  it('backgroundModelProvider: null 清除覆盖后响应里该字段为 null', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3' })
    updateBackgroundModelProviderConfigMock.mockReturnValue(null)
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/model',
      payload: { backgroundModelProvider: null },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.backgroundModelProvider).toBeNull()
  })

  it('body 未带 backgroundModelProvider 时不调用 updateBackgroundModelProviderConfig，响应仍返回当前的原始覆盖状态', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3' })
    updateModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'llama3' })
    getRawBackgroundModelProviderConfigMock.mockReturnValue({ type: 'anthropic', anthropicApiKey: 'sk-bg', modelName: 'claude-strong' })
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/model',
      payload: { modelProvider: { ollamaModel: 'llama3' } },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(updateBackgroundModelProviderConfigMock).not.toHaveBeenCalled()
    expect(body.backgroundModelProvider).toEqual({
      type: 'anthropic',
      modelName: 'claude-strong',
      hasAnthropicApiKey: true,
      hasOpenaiApiKey: false,
    })
  })
})
