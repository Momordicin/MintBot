import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { configRoutes } from './config.js'
import * as ModelProviderModule from '../providers/ModelProvider.js'
import { ConfigFileUnreadableError } from '../config/configFileError.js'

// routes/config.ts 只负责路由层的校验 + 响应整形，实际的读写职责在 config/index.ts——
// mock 掉整个 config 模块，测试聚焦于本文件自己的行为（校验规则、key 脱敏、undefined/null
// 语义），不依赖真实 config.json
const {
  getModelProviderConfigMock,
  getRawBackgroundModelProviderConfigMock,
  updateModelProviderConfigMock,
  updateBackgroundModelProviderConfigMock,
  getBackgroundModelProviderConfigMock,
  isEnvCredentialDetectedMock,
} = vi.hoisted(() => ({
  getModelProviderConfigMock: vi.fn(),
  getRawBackgroundModelProviderConfigMock: vi.fn(),
  updateModelProviderConfigMock: vi.fn(),
  updateBackgroundModelProviderConfigMock: vi.fn(),
  getBackgroundModelProviderConfigMock: vi.fn(),
  isEnvCredentialDetectedMock: vi.fn(),
}))

vi.mock('../config/index.js', () => ({
  getModelProviderConfig: getModelProviderConfigMock,
  getRawBackgroundModelProviderConfig: getRawBackgroundModelProviderConfigMock,
  updateModelProviderConfig: updateModelProviderConfigMock,
  updateBackgroundModelProviderConfig: updateBackgroundModelProviderConfigMock,
  getBackgroundModelProviderConfig: getBackgroundModelProviderConfigMock,
}))

vi.mock('../providers/envCredentials.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../providers/envCredentials.js')>()
  return { ...actual, isEnvCredentialDetected: isEnvCredentialDetectedMock }
})

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
  getBackgroundModelProviderConfigMock.mockReset()
  isEnvCredentialDetectedMock.mockReset()
  getRawBackgroundModelProviderConfigMock.mockReturnValue(null)
  getBackgroundModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3' })
  isEnvCredentialDetectedMock.mockReturnValue(false)
})

const noKeys = {
  anthropic: { hasKey: false, last4: null, fromEnv: false, envDetected: false },
  openai: { hasKey: false, last4: null, fromEnv: false, envDetected: false },
  deepseek: { hasKey: false, last4: null, fromEnv: false, envDetected: false },
}

describe('GET /config/model', () => {
  it('返回按提供方分组的 keys 状态（hasKey/last4/fromEnv/envDetected），从不回显完整 key，也不再返回 has*ApiKey', async () => {
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
      keys: { ...noKeys, anthropic: { hasKey: true, last4: 'cret', fromEnv: false, envDetected: false } },
    })
    expect(JSON.stringify(body)).not.toContain('sk-real-secret')
    expect(JSON.stringify(body)).not.toContain('hasAnthropicApiKey')
  })

  it('last4 仅在 key 长度 >= 8 时返回，更短的 key 为 null，空串视为未保存', async () => {
    getModelProviderConfigMock.mockReturnValue({
      type: 'ollama',
      ollamaModel: 'qwen3',
      anthropicApiKey: '12345678',
      openaiApiKey: '1234567',
      deepseekApiKey: '',
    })
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/config/model' })
    const { keys } = JSON.parse(response.payload).modelProvider

    expect(keys.anthropic).toMatchObject({ hasKey: true, last4: '5678' })
    expect(keys.openai).toMatchObject({ hasKey: true, last4: null })
    expect(keys.deepseek).toMatchObject({ hasKey: false, last4: null })
    expect(response.payload).not.toContain('1234567"')
    expect(response.payload).not.toContain('12345678')
  })

  it('fromEnv 取自保存的 FromEnv 标记，envDetected 取自环境变量检测', async () => {
    getModelProviderConfigMock.mockReturnValue({
      type: 'ollama',
      ollamaModel: 'qwen3',
      openaiApiKeyFromEnv: true,
      deepseekApiKeyFromEnv: false,
    })
    isEnvCredentialDetectedMock.mockImplementation((provider: string) => provider === 'openai')
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/config/model' })
    const { keys } = JSON.parse(response.payload).modelProvider

    expect(keys.openai).toEqual({ hasKey: false, last4: null, fromEnv: true, envDetected: true })
    expect(keys.deepseek).toEqual({ hasKey: false, last4: null, fromEnv: false, envDetected: false })
    expect(keys.anthropic).toEqual({ hasKey: false, last4: null, fromEnv: false, envDetected: false })
  })

  it('返回 Base URL 与 maxTokens', async () => {
    getModelProviderConfigMock.mockReturnValue({
      type: 'ollama',
      ollamaModel: 'qwen3',
      ollamaBaseUrl: 'http://localhost:11434',
      openaiBaseUrl: 'https://proxy.example/v1',
      deepseekBaseUrl: 'https://ds.example',
      maxTokens: 1500,
    })
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/config/model' })

    expect(JSON.parse(response.payload).modelProvider).toEqual({
      type: 'ollama',
      ollamaModel: 'qwen3',
      ollamaBaseUrl: 'http://localhost:11434',
      openaiBaseUrl: 'https://proxy.example/v1',
      deepseekBaseUrl: 'https://ds.example',
      maxTokens: 1500,
      keys: noKeys,
    })
  })

  it('type: deepseek 时 deepseek 分组 hasKey 为 true，从不回显真实 key', async () => {
    getModelProviderConfigMock.mockReturnValue({
      type: 'deepseek',
      deepseekApiKey: 'sk-deepseek-secret',
      modelName: 'deepseek-v4-flash',
    })
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/config/model' })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body.modelProvider).toEqual({
      type: 'deepseek',
      modelName: 'deepseek-v4-flash',
      keys: { ...noKeys, deepseek: { hasKey: true, last4: 'cret', fromEnv: false, envDetected: false } },
    })
    expect(JSON.stringify(body)).not.toContain('sk-deepseek-secret')
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

  it('配置了 backgroundModelProvider 覆盖时只返回 type/modelName/ollamaModel', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3' })
    getRawBackgroundModelProviderConfigMock.mockReturnValue({
      type: 'openai',
      modelName: 'gpt-4o',
    })
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/config/model' })
    const body = JSON.parse(response.payload)

    expect(body.backgroundModelProvider).toEqual({ type: 'openai', modelName: 'gpt-4o' })
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

  it('type: deepseek 但合并后缺 deepseekApiKey 时返回 400', async () => {
    getModelProviderConfigMock.mockImplementation(() => { throw new Error('not configured') })
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/model',
      payload: { modelProvider: { type: 'deepseek', modelName: 'deepseek-v4-flash' } },
    })

    expect(response.statusCode).toBe(400)
    expect(updateModelProviderConfigMock).not.toHaveBeenCalled()
  })

  it('type: deepseek 但合并后缺 modelName 时返回 400', async () => {
    getModelProviderConfigMock.mockImplementation(() => { throw new Error('not configured') })
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/model',
      payload: { modelProvider: { type: 'deepseek', deepseekApiKey: 'sk-deepseek' } },
    })

    expect(response.statusCode).toBe(400)
  })

  it('type: deepseek 且 deepseekApiKey/modelName 都满足时通过校验并写入成功', async () => {
    getModelProviderConfigMock.mockImplementation(() => { throw new Error('not configured') })
    updateModelProviderConfigMock.mockReturnValue({
      type: 'deepseek',
      deepseekApiKey: 'sk-deepseek',
      modelName: 'deepseek-v4-flash',
    })
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/model',
      payload: { modelProvider: { type: 'deepseek', deepseekApiKey: 'sk-deepseek', modelName: 'deepseek-v4-flash' } },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(updateModelProviderConfigMock).toHaveBeenCalledWith({
      type: 'deepseek',
      deepseekApiKey: 'sk-deepseek',
      modelName: 'deepseek-v4-flash',
    })
    expect(body.modelProvider).toEqual({
      type: 'deepseek',
      modelName: 'deepseek-v4-flash',
      keys: { ...noKeys, deepseek: { hasKey: true, last4: 'seek', fromEnv: false, envDetected: false } },
    })
    expect(JSON.stringify(body)).not.toContain('sk-deepseek"')
  })

  it('maxTokens 非整数/超出 [1, 32000] 范围时返回 400', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3' })
    const fastify = await buildTestApp()

    for (const badValue of [0, -5, 32001, 1.5]) {
      const response = await fastify.inject({
        method: 'PATCH',
        url: '/config/model',
        payload: { modelProvider: { maxTokens: badValue } },
      })
      expect(response.statusCode).toBe(400)
    }
    expect(updateModelProviderConfigMock).not.toHaveBeenCalled()
  })

  it('maxTokens 在合法范围内时通过校验、写入成功，且 GET/PATCH 响应里能读到写回的值（PATCH pick-list 陷阱的真实往返验证，而非只读代码列表）', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3' })
    updateModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3', maxTokens: 2000 })
    const fastify = await buildTestApp()

    const patchResponse = await fastify.inject({
      method: 'PATCH',
      url: '/config/model',
      payload: { modelProvider: { maxTokens: 2000 } },
    })
    const patchBody = JSON.parse(patchResponse.payload)

    expect(patchResponse.statusCode).toBe(200)
    expect(updateModelProviderConfigMock).toHaveBeenCalledWith({ maxTokens: 2000 })
    expect(patchBody.modelProvider.maxTokens).toBe(2000)

    // 独立一次 GET，确认写回的值不是只在 PATCH 响应里昙花一现——toSummary 用 ...rest 展开，
    // 不是逐字段挑选列表，因此 maxTokens 不需要额外加进哪个白名单就能原样透传
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3', maxTokens: 2000 })
    const getResponse = await fastify.inject({ method: 'GET', url: '/config/model' })
    const getBody = JSON.parse(getResponse.payload)
    expect(getBody.modelProvider.maxTokens).toBe(2000)
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
  it('modelProvider 校验通过后调用 updateModelProviderConfig，响应用返回值整形', async () => {
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
    expect(body.modelProvider).toEqual({ type: 'ollama', ollamaModel: 'llama3', keys: noKeys })
  })

  it('body 未带 modelProvider 时不调用 updateModelProviderConfig，响应仍返回当前值', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3', anthropicApiKey: 'sk-global-key' })
    getRawBackgroundModelProviderConfigMock.mockReturnValue(null)
    updateBackgroundModelProviderConfigMock.mockReturnValue({ type: 'anthropic', modelName: 'claude-strong' })
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/model',
      payload: { backgroundModelProvider: { type: 'anthropic', modelName: 'claude-strong' } },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(updateModelProviderConfigMock).not.toHaveBeenCalled()
    expect(body.modelProvider).toEqual({
      type: 'ollama',
      ollamaModel: 'qwen3',
      keys: { ...noKeys, anthropic: { hasKey: true, last4: '-key', fromEnv: false, envDetected: false } },
    })
    expect(body.backgroundModelProvider).toEqual({ type: 'anthropic', modelName: 'claude-strong' })
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
    getRawBackgroundModelProviderConfigMock.mockReturnValue({ type: 'anthropic', modelName: 'claude-strong' })
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/model',
      payload: { modelProvider: { ollamaModel: 'llama3' } },
    })
    const body = JSON.parse(response.payload)

    expect(response.statusCode).toBe(200)
    expect(updateBackgroundModelProviderConfigMock).not.toHaveBeenCalled()
    expect(body.backgroundModelProvider).toEqual({ type: 'anthropic', modelName: 'claude-strong' })
  })
})

describe('PATCH /config/model — API Key 环境变量与有效性', () => {
  async function patch(payload: unknown) {
    const fastify = await buildTestApp()
    const response = await fastify.inject({ method: 'PATCH', url: '/config/model', payload: payload as object })
    return { fastify, response, body: JSON.parse(response.payload) }
  }

  it.each([
    ['anthropicApiKeyFromEnv', 'ANTHROPIC_API_KEY'],
    ['openaiApiKeyFromEnv', 'OPENAI_API_KEY'],
    ['deepseekApiKeyFromEnv', 'DEEPSEEK_API_KEY'],
  ])('%s 设为 true 但未检测到环境变量时返回 400 并指出变量名', async (flag, envVar) => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3' })

    const { response, body } = await patch({ modelProvider: { [flag]: true } })

    expect(response.statusCode).toBe(400)
    expect(body).toEqual({ code: 'ENV_VAR_MISSING', params: { envVar } })
    expect(updateModelProviderConfigMock).not.toHaveBeenCalled()
  })

  it('FromEnv 标记设为 true 且检测到环境变量时通过，设为 false 不需要检测', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3' })
    isEnvCredentialDetectedMock.mockImplementation((provider: string) => provider === 'openai')
    updateModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3', openaiApiKeyFromEnv: true })

    const { response } = await patch({ modelProvider: { openaiApiKeyFromEnv: true, anthropicApiKeyFromEnv: false } })

    expect(response.statusCode).toBe(200)
    expect(updateModelProviderConfigMock).toHaveBeenCalledWith({ openaiApiKeyFromEnv: true, anthropicApiKeyFromEnv: false })
  })

  it('选中的对话提供方没有已保存 key 且未勾选环境变量时返回 400 API key 无效或未配置', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3' })

    const { response, body } = await patch({ modelProvider: { type: 'openai', modelName: 'gpt-4o' } })

    expect(response.statusCode).toBe(400)
    expect(body).toEqual({ code: 'API_KEY_INVALID' })
    expect(updateModelProviderConfigMock).not.toHaveBeenCalled()
  })

  it('已保存配置勾选了环境变量但当前未检测到、也没有已保存 key 时返回 400', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'openai', modelName: 'gpt-4o', openaiApiKeyFromEnv: true })

    const { response, body } = await patch({ modelProvider: { modelName: 'gpt-4o-mini' } })

    expect(response.statusCode).toBe(400)
    expect(body).toEqual({ code: 'API_KEY_INVALID' })
  })

  it('勾选环境变量但未检测到时，即使有已保存 key 也返回 400', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'openai', modelName: 'gpt-4o', openaiApiKey: 'sk-saved-openai', openaiApiKeyFromEnv: true })

    const { response, body } = await patch({ modelProvider: { modelName: 'gpt-4o-mini' } })

    expect(response.statusCode).toBe(400)
    expect(body).toEqual({ code: 'API_KEY_INVALID' })
  })

  it('已为 true 的 FromEnv 标记在未检测到环境变量时重复发送：通过校验，只要选中的提供方已配置', async () => {
    getModelProviderConfigMock.mockReturnValue({
      type: 'anthropic',
      modelName: 'claude-3',
      anthropicApiKey: 'sk-anthropic-saved',
      openaiApiKeyFromEnv: true,
    })
    updateModelProviderConfigMock.mockReturnValue({ type: 'anthropic', modelName: 'claude-3', anthropicApiKey: 'sk-anthropic-saved', openaiApiKeyFromEnv: true })

    const { response } = await patch({ modelProvider: { openaiApiKeyFromEnv: true } })

    expect(response.statusCode).toBe(200)
  })

  it('已为 true 的 FromEnv 标记重复发送后，选中该提供方仍返回 API key 无效或未配置', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3', openaiApiKey: 'sk-saved-openai', openaiApiKeyFromEnv: true })

    const { response, body } = await patch({ modelProvider: { type: 'openai', modelName: 'gpt-4o', openaiApiKeyFromEnv: true } })

    expect(response.statusCode).toBe(400)
    expect(body).toEqual({ code: 'API_KEY_INVALID' })
  })

  it('当前为 false 的 FromEnv 标记在未检测到环境变量时打开：返回 400', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3', openaiApiKeyFromEnv: false })

    const { response, body } = await patch({ modelProvider: { openaiApiKeyFromEnv: true } })

    expect(response.statusCode).toBe(400)
    expect(body).toEqual({ code: 'ENV_VAR_MISSING', params: { envVar: 'OPENAI_API_KEY' } })
  })

  it.each([
    ['空串', ''],
    ['纯空白', '   '],
  ])('key 字段为%s时被忽略：不写入，已保存的 key 不被清除', async (_label, emptyKey) => {
    getModelProviderConfigMock.mockReturnValue({ type: 'openai', modelName: 'gpt-4o', openaiApiKey: 'sk-saved-openai' })
    updateModelProviderConfigMock.mockReturnValue({ type: 'openai', modelName: 'gpt-4o-mini', openaiApiKey: 'sk-saved-openai' })

    const { response } = await patch({ modelProvider: { openaiApiKey: emptyKey, anthropicApiKey: emptyKey, deepseekApiKey: emptyKey, modelName: 'gpt-4o-mini' } })

    expect(response.statusCode).toBe(200)
    expect(updateModelProviderConfigMock).toHaveBeenCalledWith({ modelName: 'gpt-4o-mini' })
  })

  it('选中提供方只靠空 key 字段时仍返回 API key 无效或未配置', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3' })

    const { response, body } = await patch({ modelProvider: { type: 'openai', modelName: 'gpt-4o', openaiApiKey: '  ' } })

    expect(response.statusCode).toBe(400)
    expect(body).toEqual({ code: 'API_KEY_INVALID' })
  })

  it('对话提供方勾选环境变量且已检测到时视为已配置', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3' })
    isEnvCredentialDetectedMock.mockReturnValue(true)
    updateModelProviderConfigMock.mockReturnValue({ type: 'openai', modelName: 'gpt-4o', openaiApiKeyFromEnv: true })

    const { response } = await patch({ modelProvider: { type: 'openai', modelName: 'gpt-4o', openaiApiKeyFromEnv: true } })

    expect(response.statusCode).toBe(200)
  })

  it('选中 ollama 不需要 key，但仍需要 ollamaModel', async () => {
    getModelProviderConfigMock.mockImplementation(() => { throw new Error('not configured') })

    const { response } = await patch({ modelProvider: { type: 'ollama' } })

    expect(response.statusCode).toBe(400)
  })

  it('可以为当前未选中的提供方保存 key', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3' })
    updateModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3', openaiApiKey: 'sk-openai-new' })

    const { response } = await patch({ modelProvider: { openaiApiKey: 'sk-openai-new' } })

    expect(response.statusCode).toBe(200)
    expect(updateModelProviderConfigMock).toHaveBeenCalledWith({ openaiApiKey: 'sk-openai-new' })
  })

  it('后台提供方没有可用 key 时返回 400 API key 无效或未配置', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3' })

    const { response, body } = await patch({ backgroundModelProvider: { type: 'deepseek', modelName: 'deepseek-v4-flash' } })

    expect(response.statusCode).toBe(400)
    expect(body).toEqual({ code: 'API_KEY_INVALID' })
    expect(updateBackgroundModelProviderConfigMock).not.toHaveBeenCalled()
  })

  it('后台提供方的 key 取自同一请求里全局段新填的 key', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3' })
    updateModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3', deepseekApiKey: 'sk-ds-new-key' })
    updateBackgroundModelProviderConfigMock.mockReturnValue({ type: 'deepseek', modelName: 'deepseek-v4-flash' })

    const { response } = await patch({
      modelProvider: { deepseekApiKey: 'sk-ds-new-key' },
      backgroundModelProvider: { type: 'deepseek', modelName: 'deepseek-v4-flash' },
    })

    expect(response.statusCode).toBe(200)
  })

  it('后台提供方的 key 取自已保存的全局 key；后台为 ollama 时缺 ollamaModel 返回 400', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3', openaiApiKey: 'sk-saved-openai' })
    updateBackgroundModelProviderConfigMock.mockReturnValue({ type: 'openai', modelName: 'gpt-4o-mini' })
    const fastify = await buildTestApp()

    const openaiResponse = await fastify.inject({
      method: 'PATCH',
      url: '/config/model',
      payload: { backgroundModelProvider: { type: 'openai', modelName: 'gpt-4o-mini' } },
    })
    const ollamaMissingModel = await fastify.inject({
      method: 'PATCH',
      url: '/config/model',
      payload: { backgroundModelProvider: { type: 'ollama' } },
    })

    expect(openaiResponse.statusCode).toBe(200)
    expect(ollamaMissingModel.statusCode).toBe(400)
  })

  it('后台段里除 type/modelName/ollamaModel 之外的字段被静默丢弃，不返回 400', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3', openaiApiKey: 'sk-saved-openai' })
    updateBackgroundModelProviderConfigMock.mockReturnValue({ type: 'openai', modelName: 'gpt-4o-mini' })

    const { response, body } = await patch({
      backgroundModelProvider: {
        type: 'openai',
        modelName: 'gpt-4o-mini',
        openaiApiKey: 'sk-should-drop',
        openaiBaseUrl: 'https://drop.example',
        maxTokens: 99999999,
        anthropicApiKeyFromEnv: true,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(updateBackgroundModelProviderConfigMock).toHaveBeenCalledWith({ type: 'openai', modelName: 'gpt-4o-mini' })
    expect(body.backgroundModelProvider).toEqual({ type: 'openai', modelName: 'gpt-4o-mini' })
  })

  it('保存成功后按最新配置重建对话与后台 provider', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3' })
    updateModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'llama3' })
    const createSpy = vi.spyOn(ModelProviderModule, 'createModelProvider')

    await patch({ modelProvider: { ollamaModel: 'llama3' } })

    expect(createSpy).toHaveBeenCalledTimes(2)
    createSpy.mockRestore()
  })

  it('校验失败时不重建 provider', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3' })
    const createSpy = vi.spyOn(ModelProviderModule, 'createModelProvider')

    await patch({ modelProvider: { type: 'openai', modelName: 'gpt-4o' } })

    expect(createSpy).not.toHaveBeenCalled()
    createSpy.mockRestore()
  })
})

describe('PATCH /config/model — config.json 无法读取', () => {
  it('写入抛出 ConfigFileUnreadableError 时返回 500，error 为中文提示', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3' })
    updateModelProviderConfigMock.mockImplementation(() => {
      throw new ConfigFileUnreadableError('Unexpected token')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/model',
      payload: { modelProvider: { ollamaModel: 'llama3' } },
    })
    errorSpy.mockRestore()

    expect(response.statusCode).toBe(500)
    expect(JSON.parse(response.payload)).toEqual({ code: 'CONFIG_FILE_UNREADABLE' })
  })

  it('其他错误照常向外抛出，不使用 config.json 的提示文字', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'ollama', ollamaModel: 'qwen3' })
    updateModelProviderConfigMock.mockImplementation(() => {
      throw new Error('unexpected')
    })
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/config/model',
      payload: { modelProvider: { ollamaModel: 'llama3' } },
    })

    expect(response.statusCode).toBe(500)
    expect(JSON.parse(response.payload).code).not.toBe('CONFIG_FILE_UNREADABLE')
  })
})
