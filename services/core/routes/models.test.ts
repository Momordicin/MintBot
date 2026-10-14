import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'

const {
  getModelProviderConfigMock,
  listOllamaModelsMock,
  ensureOllamaMock,
  anthropicCtorMock,
  anthropicListMock,
  openaiCtorMock,
  openaiListMock,
  getEnvCredentialMock,
} = vi.hoisted(() => ({
  getModelProviderConfigMock: vi.fn(),
  listOllamaModelsMock: vi.fn(),
  ensureOllamaMock: vi.fn(),
  anthropicCtorMock: vi.fn(),
  anthropicListMock: vi.fn(),
  openaiCtorMock: vi.fn(),
  openaiListMock: vi.fn(),
  getEnvCredentialMock: vi.fn(),
}))

vi.mock('../config/index.js', () => ({
  getModelProviderConfig: getModelProviderConfigMock,
}))

vi.mock('../providers/ollama.js', () => ({
  listOllamaModels: listOllamaModelsMock,
  ensureOllama: ensureOllamaMock,
  getOllamaBaseUrl: (baseUrl?: string) => baseUrl ?? 'http://localhost:11434',
}))

vi.mock('../providers/envCredentials.js', () => ({
  getEnvCredential: getEnvCredentialMock,
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    models = { list: anthropicListMock }
    constructor(options: unknown) {
      anthropicCtorMock(options)
    }
  },
}))

vi.mock('openai', () => ({
  default: class {
    models = { list: openaiListMock }
    constructor(options: unknown) {
      openaiCtorMock(options)
    }
  },
}))

const { modelsRoutes } = await import('./models.js')

async function* pages(...ids: string[]) {
  for (const id of ids) yield { id }
}

async function buildTestApp() {
  const fastify = Fastify()
  await fastify.register(modelsRoutes)
  return fastify
}

async function getModels(type: string) {
  const fastify = await buildTestApp()
  const response = await fastify.inject({ method: 'GET', url: `/models?type=${type}` })
  return { status: response.statusCode, body: JSON.parse(response.payload) }
}

beforeEach(() => {
  getModelProviderConfigMock.mockReset()
  listOllamaModelsMock.mockReset()
  ensureOllamaMock.mockReset()
  ensureOllamaMock.mockResolvedValue(true)
  anthropicCtorMock.mockReset()
  anthropicListMock.mockReset()
  openaiCtorMock.mockReset()
  openaiListMock.mockReset()
  getEnvCredentialMock.mockReset()
  getModelProviderConfigMock.mockReturnValue({ type: 'anthropic' })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /models', () => {
  it('type=ollama 时调用 listOllamaModels，返回其结果', async () => {
    listOllamaModelsMock.mockResolvedValue(['qwen3', 'llama3'])

    const { status, body } = await getModels('ollama')

    expect(status).toBe(200)
    expect(body).toEqual({ models: ['qwen3', 'llama3'] })
    expect(listOllamaModelsMock).toHaveBeenCalledTimes(1)
    expect(ensureOllamaMock).toHaveBeenCalledTimes(1)
    expect(ensureOllamaMock.mock.invocationCallOrder[0]).toBeLessThan(listOllamaModelsMock.mock.invocationCallOrder[0])
    expect(anthropicListMock).not.toHaveBeenCalled()
    expect(openaiListMock).not.toHaveBeenCalled()
  })

  it('type=ollama 且 Ollama 未运行（listOllamaModels 返回空数组）时返回空列表而不报错', async () => {
    listOllamaModelsMock.mockResolvedValue([])

    const { status, body } = await getModels('ollama')

    expect(status).toBe(200)
    expect(body).toEqual({ models: [] })
  })

  it('type=ollama 启动失败时返回错误提示且不查询列表', async () => {
    ensureOllamaMock.mockResolvedValue(false)

    const { status, body } = await getModels('ollama')

    expect(status).toBe(200)
    expect(body).toEqual({ models: [], error: 'Ollama 启动失败' })
    expect(listOllamaModelsMock).not.toHaveBeenCalled()
  })

  it('type=anthropic 用保存的 Key 与显式参数构建客户端并返回排序后的 id', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'anthropic', anthropicApiKey: 'sk-ant-saved' })
    anthropicListMock.mockReturnValue(pages('claude-b', 'claude-a'))

    const { status, body } = await getModels('anthropic')

    expect(status).toBe(200)
    expect(body).toEqual({ models: ['claude-a', 'claude-b'] })
    expect(anthropicCtorMock).toHaveBeenCalledWith({
      apiKey: 'sk-ant-saved',
      authToken: null,
      baseURL: 'https://api.anthropic.com',
      logLevel: 'warn',
      webhookKey: null,
      maxRetries: 2,
    })
    expect(openaiCtorMock).not.toHaveBeenCalled()
    expect(listOllamaModelsMock).not.toHaveBeenCalled()
  })

  it('type=anthropic 且 anthropicApiKeyFromEnv 为 true 时使用环境变量 Key', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'anthropic', anthropicApiKey: 'sk-ant-saved', anthropicApiKeyFromEnv: true })
    getEnvCredentialMock.mockReturnValue('sk-ant-env')
    anthropicListMock.mockReturnValue(pages('claude-a'))

    const { body } = await getModels('anthropic')

    expect(body).toEqual({ models: ['claude-a'] })
    expect(getEnvCredentialMock).toHaveBeenCalledWith('anthropic')
    expect(anthropicCtorMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-ant-env' }))
  })

  it('type=openai 用保存的 Key 与默认 baseURL 构建客户端，只保留聊天模型', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'openai', openaiApiKey: 'sk-openai-saved' })
    openaiListMock.mockReturnValue(pages(
      'gpt-4o',
      'o3-mini',
      'chatgpt-4o-latest',
      'o4-mini',
      'gpt-4o-audio-preview',
      'gpt-realtime',
      'gpt-4o-transcribe',
      'gpt-4o-mini-tts',
      'gpt-image-1',
      'text-embedding-3-small',
      'gpt-4o-search-preview',
      'omni-moderation-latest',
      'dall-e-3',
      'whisper-1',
      'davinci-002',
      'omni-x'
    ))

    const { status, body } = await getModels('openai')

    expect(status).toBe(200)
    expect(body).toEqual({ models: ['chatgpt-4o-latest', 'gpt-4o', 'o3-mini', 'o4-mini'] })
    expect(openaiCtorMock).toHaveBeenCalledWith({
      apiKey: 'sk-openai-saved',
      adminAPIKey: null,
      organization: null,
      project: null,
      baseURL: 'https://api.openai.com/v1',
      webhookSecret: null,
      logLevel: 'warn',
      maxRetries: 2,
    })
  })

  it('type=openai 使用配置的 openaiBaseUrl，且 openaiApiKeyFromEnv 为 true 时使用环境变量 Key', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'openai', openaiApiKey: 'sk-saved', openaiApiKeyFromEnv: true, openaiBaseUrl: 'http://proxy.local/v1' })
    getEnvCredentialMock.mockReturnValue('sk-openai-env')
    openaiListMock.mockReturnValue(pages('gpt-4o'))

    const { body } = await getModels('openai')

    expect(body).toEqual({ models: ['gpt-4o'] })
    expect(getEnvCredentialMock).toHaveBeenCalledWith('openai')
    expect(openaiCtorMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-openai-env', baseURL: 'http://proxy.local/v1' }))
  })

  it('type=deepseek 通过 OpenAI SDK 与默认 DeepSeek baseURL 查询，不做 id 过滤', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'deepseek', deepseekApiKey: 'sk-ds-saved' })
    openaiListMock.mockReturnValue(pages('deepseek-v4-pro', 'deepseek-v4-flash'))

    const { status, body } = await getModels('deepseek')

    expect(status).toBe(200)
    expect(body).toEqual({ models: ['deepseek-v4-flash', 'deepseek-v4-pro'] })
    expect(openaiCtorMock).toHaveBeenCalledWith({
      apiKey: 'sk-ds-saved',
      adminAPIKey: null,
      organization: null,
      project: null,
      baseURL: 'https://api.deepseek.com',
      webhookSecret: null,
      logLevel: 'warn',
      maxRetries: 2,
    })
    expect(anthropicCtorMock).not.toHaveBeenCalled()
  })

  it('type=deepseek 使用配置的 deepseekBaseUrl，且 deepseekApiKeyFromEnv 为 true 时使用环境变量 Key', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'deepseek', deepseekApiKeyFromEnv: true, deepseekBaseUrl: 'http://ds.local' })
    getEnvCredentialMock.mockReturnValue('sk-ds-env')
    openaiListMock.mockReturnValue(pages('deepseek-v4-flash'))

    const { body } = await getModels('deepseek')

    expect(body).toEqual({ models: ['deepseek-v4-flash'] })
    expect(getEnvCredentialMock).toHaveBeenCalledWith('deepseek')
    expect(openaiCtorMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-ds-env', baseURL: 'http://ds.local' }))
  })

  it('列表请求使用 15 秒超时且不重试', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'anthropic', anthropicApiKey: 'k', openaiApiKey: 'k', deepseekApiKey: 'k' })
    anthropicListMock.mockReturnValue(pages('claude-a'))
    openaiListMock.mockReturnValue(pages('gpt-4o'))

    await getModels('anthropic')
    await getModels('openai')
    await getModels('deepseek')

    expect(anthropicListMock).toHaveBeenCalledWith(undefined, { timeout: 15000, maxRetries: 0 })
    expect(openaiListMock).toHaveBeenCalledTimes(2)
    expect(openaiListMock).toHaveBeenNthCalledWith(1, { timeout: 15000, maxRetries: 0 })
    expect(openaiListMock).toHaveBeenNthCalledWith(2, { timeout: 15000, maxRetries: 0 })
  })

  it.each(['anthropic', 'openai', 'deepseek'])('type=%s 没有可用 Key 时不发请求并返回错误提示', async type => {
    getModelProviderConfigMock.mockReturnValue({ type })

    const { status, body } = await getModels(type)

    expect(status).toBe(200)
    expect(body).toEqual({ models: [], error: 'API key 无效或未配置' })
    expect(anthropicListMock).not.toHaveBeenCalled()
    expect(openaiListMock).not.toHaveBeenCalled()
  })

  it('环境变量标志开启但环境变量为空时不发请求并返回错误提示', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'openai', openaiApiKey: 'sk-saved', openaiApiKeyFromEnv: true })
    getEnvCredentialMock.mockReturnValue('')

    const { body } = await getModels('openai')

    expect(body).toEqual({ models: [], error: 'API key 无效或未配置' })
    expect(openaiListMock).not.toHaveBeenCalled()
  })

  it.each(['anthropic', 'openai', 'deepseek'])('type=%s 的 SDK 抛错时返回通用失败提示且不泄露详情', async type => {
    getModelProviderConfigMock.mockReturnValue({ type, anthropicApiKey: 'k', openaiApiKey: 'k', deepseekApiKey: 'k' })
    const failure = () => ({
      [Symbol.asyncIterator]() {
        return { next: () => Promise.reject(new Error('401 secret-detail')) }
      },
    })
    anthropicListMock.mockImplementation(failure)
    openaiListMock.mockImplementation(failure)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { status, body } = await getModels(type)

    expect(status).toBe(200)
    expect(body).toEqual({ models: [], error: '获取模型列表失败' })
    expect(JSON.stringify(body)).not.toContain('secret-detail')
    expect(errorSpy).toHaveBeenCalled()
  })

  it('type 缺失或无效时返回 400', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/models' })

    expect(response.statusCode).toBe(400)
    expect(JSON.parse(response.payload)).toHaveProperty('error')
  })
})
