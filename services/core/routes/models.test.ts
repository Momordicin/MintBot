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
  getPresetByIdMock,
  getPresetApiKeysMock,
} = vi.hoisted(() => ({
  getModelProviderConfigMock: vi.fn(),
  listOllamaModelsMock: vi.fn(),
  ensureOllamaMock: vi.fn(),
  anthropicCtorMock: vi.fn(),
  anthropicListMock: vi.fn(),
  openaiCtorMock: vi.fn(),
  openaiListMock: vi.fn(),
  getEnvCredentialMock: vi.fn(),
  getPresetByIdMock: vi.fn(),
  getPresetApiKeysMock: vi.fn(),
}))

vi.mock('../session/queries.js', () => ({
  getPresetById: getPresetByIdMock,
  getPresetApiKeys: getPresetApiKeysMock,
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

async function getPresetModels(type: string, presetId: string) {
  const fastify = await buildTestApp()
  const response = await fastify.inject({ method: 'GET', url: `/models?type=${type}&presetId=${presetId}` })
  return { status: response.statusCode, body: JSON.parse(response.payload) }
}

async function postModels(payload: Record<string, unknown>) {
  const fastify = await buildTestApp()
  const response = await fastify.inject({ method: 'POST', url: '/models', payload })
  return { status: response.statusCode, body: JSON.parse(response.payload) }
}

const noKeys = {
  anthropic: { fromEnv: false },
  openai: { fromEnv: false },
  deepseek: { fromEnv: false },
}

describe('GET /models?presetId', () => {
  beforeEach(() => {
    getPresetByIdMock.mockReset()
    getPresetByIdMock.mockReturnValue({ presetId: 'p1' })
    getPresetApiKeysMock.mockReset()
    getPresetApiKeysMock.mockReturnValue(noKeys)
  })

  it('使用该角色保存的 key 查询，不使用全局 key，Base URL 仍取全局配置', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'openai', openaiApiKey: 'sk-global', openaiBaseUrl: 'http://proxy.local/v1' })
    getPresetApiKeysMock.mockReturnValue({ ...noKeys, openai: { apiKey: 'sk-role', fromEnv: false } })
    openaiListMock.mockReturnValue(pages('gpt-4o', 'whisper-1', 'gpt-4o-mini'))

    const { status, body } = await getPresetModels('openai', 'p1')

    expect(status).toBe(200)
    expect(body).toEqual({ models: ['gpt-4o', 'gpt-4o-mini'] })
    expect(openaiCtorMock).toHaveBeenCalledTimes(1)
    expect(openaiCtorMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-role', baseURL: 'http://proxy.local/v1' }))
    expect(openaiListMock).toHaveBeenCalledWith({ timeout: 15000, maxRetries: 0 })
    expect(getPresetApiKeysMock).toHaveBeenCalledWith('p1')
  })

  it('角色勾选环境变量时使用环境暂存的 key', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'anthropic', anthropicApiKey: 'sk-global' })
    getPresetApiKeysMock.mockReturnValue({ ...noKeys, anthropic: { apiKey: 'sk-role', fromEnv: true } })
    getEnvCredentialMock.mockReturnValue('sk-ant-env')
    anthropicListMock.mockReturnValue(pages('claude-b', 'claude-a'))

    const { body } = await getPresetModels('anthropic', 'p1')

    expect(body).toEqual({ models: ['claude-a', 'claude-b'] })
    expect(getEnvCredentialMock).toHaveBeenCalledWith('anthropic')
    expect(anthropicCtorMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-ant-env' }))
    expect(anthropicListMock).toHaveBeenCalledWith(undefined, { timeout: 15000, maxRetries: 0 })
  })

  it.each(['anthropic', 'openai', 'deepseek'])('type=%s 角色没有可用 key（即使全局有 key）：不发请求并返回错误提示', async type => {
    getModelProviderConfigMock.mockReturnValue({ type, anthropicApiKey: 'g', openaiApiKey: 'g', deepseekApiKey: 'g' })

    const { status, body } = await getPresetModels(type, 'p1')

    expect(status).toBe(200)
    expect(body).toEqual({ models: [], error: 'API key 无效或未配置' })
    expect(anthropicCtorMock).not.toHaveBeenCalled()
    expect(openaiCtorMock).not.toHaveBeenCalled()
    expect(anthropicListMock).not.toHaveBeenCalled()
    expect(openaiListMock).not.toHaveBeenCalled()
  })

  it('角色勾选环境变量但环境变量为空：不发请求并返回错误提示', async () => {
    getPresetApiKeysMock.mockReturnValue({ ...noKeys, deepseek: { apiKey: 'sk-role', fromEnv: true } })
    getEnvCredentialMock.mockReturnValue('')

    const { body } = await getPresetModels('deepseek', 'p1')

    expect(body).toEqual({ models: [], error: 'API key 无效或未配置' })
    expect(openaiListMock).not.toHaveBeenCalled()
  })

  it('全局模型配置尚未建立时仍可用角色 key 查询（Base URL 取默认值）', async () => {
    getModelProviderConfigMock.mockImplementation(() => {
      throw new Error('[Config] modelProvider is not configured')
    })
    getPresetApiKeysMock.mockReturnValue({ ...noKeys, deepseek: { apiKey: 'sk-role', fromEnv: false } })
    openaiListMock.mockReturnValue(pages('deepseek-v4-flash'))

    const { body } = await getPresetModels('deepseek', 'p1')

    expect(body).toEqual({ models: ['deepseek-v4-flash'] })
    expect(openaiCtorMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-role', baseURL: 'https://api.deepseek.com' }))
  })

  it('未知 preset 返回 404 且不发请求', async () => {
    getPresetByIdMock.mockReturnValue(null)

    const { status } = await getPresetModels('openai', 'missing')

    expect(status).toBe(404)
    expect(openaiCtorMock).not.toHaveBeenCalled()
  })

  it('type=ollama 忽略 presetId，即使 preset 不存在', async () => {
    getPresetByIdMock.mockReturnValue(null)
    listOllamaModelsMock.mockResolvedValue(['qwen3'])

    const { status, body } = await getPresetModels('ollama', 'missing')

    expect(status).toBe(200)
    expect(body).toEqual({ models: ['qwen3'] })
    expect(getPresetApiKeysMock).not.toHaveBeenCalled()
  })

  it('不带 presetId 时仍使用全局 key，不读取角色 key', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'openai', openaiApiKey: 'sk-global' })
    openaiListMock.mockReturnValue(pages('gpt-4o'))

    const { body } = await getModels('openai')

    expect(body).toEqual({ models: ['gpt-4o'] })
    expect(openaiCtorMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-global' }))
    expect(getPresetApiKeysMock).not.toHaveBeenCalled()
  })
})

describe('POST /models', () => {
  beforeEach(() => {
    getPresetApiKeysMock.mockReset()
    getPresetByIdMock.mockReset()
  })

  it('用请求体里的 key 列出一次：不使用全局 key，不写入配置，不进日志', async () => {
    const globalConfig = { type: 'openai', openaiApiKey: 'sk-global', openaiBaseUrl: 'http://proxy.local/v1' }
    getModelProviderConfigMock.mockReturnValue(globalConfig)
    openaiListMock.mockReturnValue(pages('gpt-4o', 'dall-e-3', 'gpt-4o-mini'))
    const logSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ]

    const { status, body } = await postModels({ type: 'openai', apiKey: 'sk-typed-secret' })

    expect(status).toBe(200)
    expect(body).toEqual({ models: ['gpt-4o', 'gpt-4o-mini'] })
    expect(openaiCtorMock).toHaveBeenCalledTimes(1)
    expect(openaiCtorMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-typed-secret', baseURL: 'http://proxy.local/v1' }))
    expect(openaiListMock).toHaveBeenCalledTimes(1)
    expect(openaiListMock).toHaveBeenCalledWith({ timeout: 15000, maxRetries: 0 })
    expect(globalConfig).toEqual({ type: 'openai', openaiApiKey: 'sk-global', openaiBaseUrl: 'http://proxy.local/v1' })
    expect(JSON.stringify(body)).not.toContain('sk-typed-secret')
    expect(JSON.stringify(logSpies.map(spy => spy.mock.calls))).not.toContain('sk-typed-secret')
    expect(getPresetApiKeysMock).not.toHaveBeenCalled()
  })

  it('anthropic 与 deepseek 同样用请求体里的 key', async () => {
    anthropicListMock.mockReturnValue(pages('claude-a'))
    openaiListMock.mockReturnValue(pages('deepseek-v4-flash'))

    const anthropic = await postModels({ type: 'anthropic', apiKey: 'sk-ant-typed' })
    const deepseek = await postModels({ type: 'deepseek', apiKey: 'sk-ds-typed' })

    expect(anthropic.body).toEqual({ models: ['claude-a'] })
    expect(deepseek.body).toEqual({ models: ['deepseek-v4-flash'] })
    expect(anthropicCtorMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-ant-typed' }))
    expect(openaiCtorMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-ds-typed', baseURL: 'https://api.deepseek.com' }))
  })

  it('全局配置里勾选了环境变量也不影响：只使用请求体里的 key', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'openai', openaiApiKey: 'sk-global', openaiApiKeyFromEnv: true })
    getEnvCredentialMock.mockReturnValue('sk-openai-env')
    openaiListMock.mockReturnValue(pages('gpt-4o'))

    await postModels({ type: 'openai', apiKey: 'sk-typed' })

    expect(openaiCtorMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-typed' }))
    expect(getEnvCredentialMock).not.toHaveBeenCalled()
  })

  it.each([{ apiKey: '' }, { apiKey: '   ' }, {}])('apiKey 为空或缺失（%j）：不发请求并返回错误提示，即使全局有 key', async extra => {
    getModelProviderConfigMock.mockReturnValue({ type: 'openai', openaiApiKey: 'sk-global' })

    const { status, body } = await postModels({ type: 'openai', ...extra })

    expect(status).toBe(200)
    expect(body).toEqual({ models: [], error: 'API key 无效或未配置' })
    expect(openaiCtorMock).not.toHaveBeenCalled()
    expect(openaiListMock).not.toHaveBeenCalled()
  })

  it('SDK 抛错时返回通用失败提示且不泄露详情和 key', async () => {
    openaiListMock.mockImplementation(() => ({
      [Symbol.asyncIterator]() {
        return { next: () => Promise.reject(new Error('401 secret-detail')) }
      },
    }))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const { body } = await postModels({ type: 'openai', apiKey: 'sk-typed' })

    expect(body).toEqual({ models: [], error: '获取模型列表失败' })
    expect(JSON.stringify(body)).not.toContain('sk-typed')
  })

  it('全局模型配置尚未建立时仍可用请求体里的 key 查询', async () => {
    getModelProviderConfigMock.mockImplementation(() => {
      throw new Error('[Config] modelProvider is not configured')
    })
    anthropicListMock.mockReturnValue(pages('claude-a'))

    const { body } = await postModels({ type: 'anthropic', apiKey: 'sk-ant-typed' })

    expect(body).toEqual({ models: ['claude-a'] })
  })

  it('type=ollama 与 GET 行为一致，不看 apiKey', async () => {
    listOllamaModelsMock.mockResolvedValue(['qwen3'])

    const { status, body } = await postModels({ type: 'ollama', apiKey: 'ignored' })

    expect(status).toBe(200)
    expect(body).toEqual({ models: ['qwen3'] })
    expect(ensureOllamaMock).toHaveBeenCalledTimes(1)
    expect(openaiCtorMock).not.toHaveBeenCalled()
  })

  it('type=ollama 启动失败时返回错误提示', async () => {
    ensureOllamaMock.mockResolvedValue(false)

    const { body } = await postModels({ type: 'ollama' })

    expect(body).toEqual({ models: [], error: 'Ollama 启动失败' })
    expect(listOllamaModelsMock).not.toHaveBeenCalled()
  })

  it('type 缺失或无效时返回 400', async () => {
    const missing = await postModels({ apiKey: 'sk-x' })
    const invalid = await postModels({ type: 'bogus', apiKey: 'sk-x' })

    expect(missing.status).toBe(400)
    expect(invalid.status).toBe(400)
  })
})

async function getFromEnv(type: string, presetId?: string) {
  const fastify = await buildTestApp()
  const suffix = presetId === undefined ? '' : `&presetId=${presetId}`
  const response = await fastify.inject({ method: 'GET', url: `/models?type=${type}&fromEnv=1${suffix}` })
  return { status: response.statusCode, body: JSON.parse(response.payload) }
}

describe('GET /models?fromEnv=1', () => {
  beforeEach(() => {
    getPresetByIdMock.mockReset()
    getPresetByIdMock.mockReturnValue({ presetId: 'p1' })
    getPresetApiKeysMock.mockReset()
    getPresetApiKeysMock.mockReturnValue(noKeys)
  })

  it('使用环境暂存的 key，忽略全局已保存的 key 与全局的 FromEnv 标记', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'openai', openaiApiKey: 'sk-global', openaiApiKeyFromEnv: false, openaiBaseUrl: 'http://proxy.local/v1' })
    getEnvCredentialMock.mockReturnValue('sk-openai-env')
    openaiListMock.mockReturnValue(pages('gpt-4o'))

    const { body } = await getFromEnv('openai')

    expect(body).toEqual({ models: ['gpt-4o'] })
    expect(getEnvCredentialMock).toHaveBeenCalledWith('openai')
    expect(openaiCtorMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-openai-env', baseURL: 'http://proxy.local/v1' }))
    expect(openaiListMock).toHaveBeenCalledWith({ timeout: 15000, maxRetries: 0 })
  })

  it('带 presetId 时同样使用环境 key，忽略角色已保存的 key，也不读取角色 key 行', async () => {
    getPresetApiKeysMock.mockReturnValue({ ...noKeys, anthropic: { apiKey: 'sk-role', fromEnv: false } })
    getEnvCredentialMock.mockReturnValue('sk-ant-env')
    anthropicListMock.mockReturnValue(pages('claude-a'))

    const { body } = await getFromEnv('anthropic', 'p1')

    expect(body).toEqual({ models: ['claude-a'] })
    expect(anthropicCtorMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-ant-env' }))
    expect(getPresetApiKeysMock).not.toHaveBeenCalled()
  })

  it.each(['anthropic', 'openai', 'deepseek'])('type=%s 环境变量缺失：不发请求并返回错误提示，即使全局有 key', async type => {
    getModelProviderConfigMock.mockReturnValue({ type, anthropicApiKey: 'g', openaiApiKey: 'g', deepseekApiKey: 'g' })
    getEnvCredentialMock.mockReturnValue('')

    const { status, body } = await getFromEnv(type)

    expect(status).toBe(200)
    expect(body).toEqual({ models: [], error: 'API key 无效或未配置' })
    expect(anthropicCtorMock).not.toHaveBeenCalled()
    expect(openaiCtorMock).not.toHaveBeenCalled()
    expect(anthropicListMock).not.toHaveBeenCalled()
    expect(openaiListMock).not.toHaveBeenCalled()
  })

  it('未知 preset 仍返回 404 且不发请求', async () => {
    getPresetByIdMock.mockReturnValue(null)
    getEnvCredentialMock.mockReturnValue('sk-env')

    const { status } = await getFromEnv('openai', 'missing')

    expect(status).toBe(404)
    expect(openaiCtorMock).not.toHaveBeenCalled()
  })

  it('全局模型配置尚未建立时仍可用环境 key 查询', async () => {
    getModelProviderConfigMock.mockImplementation(() => {
      throw new Error('[Config] modelProvider is not configured')
    })
    getEnvCredentialMock.mockReturnValue('sk-ds-env')
    openaiListMock.mockReturnValue(pages('deepseek-v4-flash'))

    const { body } = await getFromEnv('deepseek')

    expect(body).toEqual({ models: ['deepseek-v4-flash'] })
    expect(openaiCtorMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-ds-env', baseURL: 'https://api.deepseek.com' }))
  })

  it('type=ollama 忽略 fromEnv', async () => {
    listOllamaModelsMock.mockResolvedValue(['qwen3'])

    const { body } = await getFromEnv('ollama')

    expect(body).toEqual({ models: ['qwen3'] })
    expect(getEnvCredentialMock).not.toHaveBeenCalled()
  })

  it('fromEnv 不是 1 时行为不变，仍使用已保存的全局 key', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'openai', openaiApiKey: 'sk-global' })
    getEnvCredentialMock.mockReturnValue('sk-openai-env')
    openaiListMock.mockReturnValue(pages('gpt-4o'))
    const fastify = await buildTestApp()

    await fastify.inject({ method: 'GET', url: '/models?type=openai&fromEnv=0' })

    expect(openaiCtorMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-global' }))
  })
})

async function getFromEnvOff(type: string, presetId?: string) {
  const fastify = await buildTestApp()
  const suffix = presetId === undefined ? '' : `&presetId=${presetId}`
  const response = await fastify.inject({ method: 'GET', url: `/models?type=${type}&fromEnv=0${suffix}` })
  return { status: response.statusCode, body: JSON.parse(response.payload) }
}

describe('GET /models?fromEnv=0', () => {
  beforeEach(() => {
    getPresetByIdMock.mockReset()
    getPresetByIdMock.mockReturnValue({ presetId: 'p1' })
    getPresetApiKeysMock.mockReset()
    getPresetApiKeysMock.mockReturnValue(noKeys)
  })

  it('不带 presetId：全局 FromEnv 已保存为开启时仍使用全局已保存的 key，不读环境变量', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'openai', openaiApiKey: 'sk-global', openaiApiKeyFromEnv: true, openaiBaseUrl: 'http://proxy.local/v1' })
    getEnvCredentialMock.mockReturnValue('sk-openai-env')
    openaiListMock.mockReturnValue(pages('gpt-4o'))

    const { body } = await getFromEnvOff('openai')

    expect(body).toEqual({ models: ['gpt-4o'] })
    expect(openaiCtorMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-global', baseURL: 'http://proxy.local/v1' }))
    expect(getEnvCredentialMock).not.toHaveBeenCalled()
  })

  it('带 presetId：角色 FromEnv 已保存为开启时仍使用角色已保存的 key，不读环境变量', async () => {
    getModelProviderConfigMock.mockReturnValue({ type: 'anthropic', anthropicApiKey: 'sk-global' })
    getPresetApiKeysMock.mockReturnValue({ ...noKeys, anthropic: { apiKey: 'sk-role', fromEnv: true } })
    getEnvCredentialMock.mockReturnValue('sk-ant-env')
    anthropicListMock.mockReturnValue(pages('claude-a'))

    const { body } = await getFromEnvOff('anthropic', 'p1')

    expect(body).toEqual({ models: ['claude-a'] })
    expect(anthropicCtorMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-role' }))
    expect(getEnvCredentialMock).not.toHaveBeenCalled()
  })

  it.each(['anthropic', 'openai', 'deepseek'])('type=%s 不带 presetId 且全局没有已保存的 key：不发请求并返回错误提示，即使环境变量可用', async type => {
    getModelProviderConfigMock.mockReturnValue({ type, anthropicApiKeyFromEnv: true, openaiApiKeyFromEnv: true, deepseekApiKeyFromEnv: true })
    getEnvCredentialMock.mockReturnValue('sk-env')

    const { status, body } = await getFromEnvOff(type)

    expect(status).toBe(200)
    expect(body).toEqual({ models: [], error: 'API key 无效或未配置' })
    expect(anthropicCtorMock).not.toHaveBeenCalled()
    expect(openaiCtorMock).not.toHaveBeenCalled()
    expect(anthropicListMock).not.toHaveBeenCalled()
    expect(openaiListMock).not.toHaveBeenCalled()
  })

  it.each(['anthropic', 'openai', 'deepseek'])('type=%s 带 presetId 且角色没有已保存的 key：不发请求并返回错误提示，即使角色勾选了环境变量且全局有 key', async type => {
    getModelProviderConfigMock.mockReturnValue({ type, anthropicApiKey: 'g', openaiApiKey: 'g', deepseekApiKey: 'g' })
    getPresetApiKeysMock.mockReturnValue({ anthropic: { fromEnv: true }, openai: { fromEnv: true }, deepseek: { fromEnv: true } })
    getEnvCredentialMock.mockReturnValue('sk-env')

    const { status, body } = await getFromEnvOff(type, 'p1')

    expect(status).toBe(200)
    expect(body).toEqual({ models: [], error: 'API key 无效或未配置' })
    expect(anthropicCtorMock).not.toHaveBeenCalled()
    expect(openaiCtorMock).not.toHaveBeenCalled()
    expect(anthropicListMock).not.toHaveBeenCalled()
    expect(openaiListMock).not.toHaveBeenCalled()
  })

  it('未知 preset 仍返回 404，type=ollama 忽略 fromEnv', async () => {
    getPresetByIdMock.mockReturnValue(null)
    listOllamaModelsMock.mockResolvedValue(['qwen3'])

    const unknown = await getFromEnvOff('openai', 'missing')
    const ollama = await getFromEnvOff('ollama', 'missing')

    expect(unknown.status).toBe(404)
    expect(ollama.body).toEqual({ models: ['qwen3'] })
  })
})
