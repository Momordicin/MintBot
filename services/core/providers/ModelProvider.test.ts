import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Preset, ModelConfig, BuiltContext, CompletionOptions } from '../../../shared/types/index.js'
import type { PresetCredentials } from '../session/queries.js'

const { anthropicCtorMock, anthropicCreateMock, anthropicStreamMock, openaiCtorMock, openaiCreateMock } = vi.hoisted(() => ({
  anthropicCtorMock: vi.fn(),
  anthropicCreateMock: vi.fn(),
  anthropicStreamMock: vi.fn(),
  openaiCtorMock: vi.fn(),
  openaiCreateMock: vi.fn(),
}))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreateMock, stream: anthropicStreamMock }
    constructor(options: unknown) {
      anthropicCtorMock(options)
    }
  },
}))
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: openaiCreateMock } }
    constructor(options: unknown) {
      openaiCtorMock(options)
    }
  },
}))

const { createModelProviderForPreset, createModelProvider, resolveApiKey } = await import('./ModelProvider.js')
const { wipeCredentialEnv } = await import('./envCredentials.js')

function fakePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    presetId: 'p1',
    name: 'test',
    characterId: 'c1',
    modelType: 'ollama',
    modelName: 'llama3',
    displayConfig: { chatBgRgb: [15, 15, 20], chatBgOpacity: 0.65, themeMode: 'auto', accentRgb: [15, 15, 20], tintStrength: 0, currentPortrait: 'pixel', petScale: { pixel: 1, illustration: 1 } },
    systemPrompt: 'sys',
    addressForms: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

const noCredentials: PresetCredentials = {
  anthropic: { fromEnv: false },
  openai: { fromEnv: false },
  deepseek: { fromEnv: false },
}

function credentialsWith(overrides: Partial<PresetCredentials>): PresetCredentials {
  return { ...noCredentials, ...overrides }
}

function fakeStreamResponse(): Response {
  const body = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

afterEach(() => {
  vi.unstubAllGlobals()
  anthropicCtorMock.mockReset()
  anthropicCreateMock.mockReset()
  anthropicStreamMock.mockReset()
  openaiCtorMock.mockReset()
  openaiCreateMock.mockReset()
})

async function* openaiStream(...texts: string[]) {
  for (const text of texts) yield { choices: [{ delta: { content: text } }] }
}

function openaiCompletion(content: string) {
  return { choices: [{ message: { content } }] }
}

function fakeNonStreamResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
}

function fakeErrorResponse(status: number, statusText: string, body: string): Response {
  return new Response(body, { status, statusText })
}

async function drain(provider: ReturnType<typeof createModelProviderForPreset>): Promise<void> {
  const context: BuiltContext = { system: '', messages: [{ role: 'user', content: 'hi' }] }
  for await (const _chunk of provider.complete(context)) {
  }
}

async function drainWith(
  provider: ReturnType<typeof createModelProviderForPreset>,
  context: BuiltContext,
  options: CompletionOptions
): Promise<void> {
  for await (const _chunk of provider.complete(context, options)) {
  }
}

describe('createModelProviderForPreset', () => {
  it('ollama 类型下 preset.modelName 写入 config.ollamaModel，而不是 config.modelName', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeStreamResponse())
    vi.stubGlobal('fetch', fetchSpy)

    const globalConfig: ModelConfig = { type: 'anthropic', modelName: 'should-not-be-used' }
    const preset = fakePreset({ modelType: 'ollama', modelName: 'llama3' })

    const provider = createModelProviderForPreset(preset, globalConfig, noCredentials)
    await drain(provider)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, options] = fetchSpy.mock.calls[0]
    expect(url).toContain('/v1/chat/completions')
    const body = JSON.parse(options.body)
    expect(body.model).toBe('llama3')
    expect(body.model).not.toBe('should-not-be-used')
  })

  it('非 ollama 类型（openai）下 preset.modelName 写入 config.modelName，且使用角色 key 而不是全局 key', async () => {
    openaiCreateMock.mockResolvedValue(openaiStream('hi'))

    const globalConfig: ModelConfig = { type: 'ollama', ollamaModel: 'should-not-be-used', openaiApiKey: 'global-key' }
    const preset = fakePreset({ modelType: 'openai', modelName: 'gpt-4o-mini' })

    await drain(createModelProviderForPreset(preset, globalConfig, credentialsWith({ openai: { apiKey: 'role-key', fromEnv: false } })))

    expect(openaiCtorMock.mock.calls[0][0].apiKey).toBe('role-key')
    expect(openaiCreateMock.mock.calls[0][0].model).toBe('gpt-4o-mini')
  })

  it('preset.modelType/modelName 为 null 时，完全使用 globalConfig，不做任何覆盖', async () => {
    openaiCreateMock.mockResolvedValue(openaiStream('hi'))

    const globalConfig: ModelConfig = { type: 'openai', modelName: 'global-model', openaiApiKey: 'global-key' }
    const preset = fakePreset({ modelType: null, modelName: null })

    await drain(createModelProviderForPreset(preset, globalConfig, credentialsWith({ openai: { apiKey: 'role-key', fromEnv: false } })))

    expect(openaiCtorMock.mock.calls[0][0].apiKey).toBe('global-key')
    expect(openaiCreateMock.mock.calls[0][0].model).toBe('global-model')
  })

  it('globalConfig 同时持有 openai/deepseek 两组凭据时，preset 覆盖为 deepseek 只使用 deepseek 凭据', async () => {
    openaiCreateMock.mockResolvedValue(openaiStream('hi'))

    const globalConfig: ModelConfig = {
      type: 'openai',
      openaiApiKey: 'sk-openai',
      openaiBaseUrl: 'https://api.openai.com/v1',
      deepseekApiKey: 'sk-deepseek',
      deepseekBaseUrl: 'https://api.deepseek.com',
    }
    const preset = fakePreset({ modelType: 'deepseek', modelName: 'deepseek-v4-pro' })

    await drain(createModelProviderForPreset(preset, globalConfig, credentialsWith({
      openai: { apiKey: 'role-openai', fromEnv: false },
      deepseek: { apiKey: 'role-deepseek', fromEnv: false },
    })))

    const ctorArgs = openaiCtorMock.mock.calls[0][0]
    expect(ctorArgs.apiKey).toBe('role-deepseek')
    expect(ctorArgs.baseURL).toBe('https://api.deepseek.com')
    expect(openaiCreateMock.mock.calls[0][0].model).toBe('deepseek-v4-pro')
  })

  it('globalConfig 同时持有 openai/deepseek 两组凭据时，preset 覆盖为 openai 只使用 openai 凭据', async () => {
    openaiCreateMock.mockResolvedValue(openaiStream('hi'))

    const globalConfig: ModelConfig = {
      type: 'deepseek',
      openaiApiKey: 'sk-openai',
      openaiBaseUrl: 'https://api.openai.com/v1',
      deepseekApiKey: 'sk-deepseek',
      deepseekBaseUrl: 'https://api.deepseek.com',
    }
    const preset = fakePreset({ modelType: 'openai', modelName: 'gpt-4o-mini' })

    await drain(createModelProviderForPreset(preset, globalConfig, credentialsWith({
      openai: { apiKey: 'role-openai', fromEnv: false },
      deepseek: { apiKey: 'role-deepseek', fromEnv: false },
    })))

    const ctorArgs = openaiCtorMock.mock.calls[0][0]
    expect(ctorArgs.apiKey).toBe('role-openai')
    expect(ctorArgs.baseURL).toBe('https://api.openai.com/v1')
    expect(openaiCreateMock.mock.calls[0][0].model).toBe('gpt-4o-mini')
  })
})

describe('SDK 构造参数', () => {
  const context: BuiltContext = { system: '', messages: [{ role: 'user', content: 'hi' }] }

  it('anthropic：全部参数显式传入', async () => {
    anthropicCreateMock.mockResolvedValue({ content: [{ type: 'text', text: 'x' }] })
    await createModelProvider({ type: 'anthropic', modelName: 'claude-3', anthropicApiKey: 'k-a' }).completeSync(context)

    expect(anthropicCtorMock).toHaveBeenCalledTimes(1)
    expect(anthropicCtorMock.mock.calls[0][0]).toEqual({
      apiKey: 'k-a',
      authToken: null,
      baseURL: 'https://api.anthropic.com',
      logLevel: 'warn',
      webhookKey: null,
      maxRetries: 2,
    })
  })

  it('openai：全部参数显式传入，baseURL 用 openaiBaseUrl', async () => {
    openaiCreateMock.mockResolvedValue(openaiCompletion('x'))
    await createModelProvider({ type: 'openai', openaiApiKey: 'k-o', openaiBaseUrl: 'https://proxy.example/v1' }).completeSync(context)

    expect(openaiCtorMock).toHaveBeenCalledTimes(1)
    expect(openaiCtorMock.mock.calls[0][0]).toEqual({
      apiKey: 'k-o',
      adminAPIKey: null,
      organization: null,
      project: null,
      baseURL: 'https://proxy.example/v1',
      webhookSecret: null,
      logLevel: 'warn',
      maxRetries: 2,
    })
  })

  it('openai：openaiBaseUrl 为空串时 baseURL 回落到官方地址', async () => {
    openaiCreateMock.mockResolvedValue(openaiCompletion('x'))
    await createModelProvider({ type: 'openai', openaiApiKey: 'k-o', openaiBaseUrl: '' }).completeSync(context)

    expect(openaiCtorMock.mock.calls[0][0].baseURL).toBe('https://api.openai.com/v1')
  })

  it('deepseek：全部参数显式传入，baseURL 默认 https://api.deepseek.com', async () => {
    openaiCreateMock.mockResolvedValue(openaiCompletion('x'))
    await createModelProvider({ type: 'deepseek', deepseekApiKey: 'k-d' }).completeSync(context)

    expect(openaiCtorMock.mock.calls[0][0]).toEqual({
      apiKey: 'k-d',
      adminAPIKey: null,
      organization: null,
      project: null,
      baseURL: 'https://api.deepseek.com',
      webhookSecret: null,
      logLevel: 'warn',
      maxRetries: 2,
    })
  })

  it('deepseek：deepseekBaseUrl 覆盖默认地址', async () => {
    openaiCreateMock.mockResolvedValue(openaiCompletion('x'))
    await createModelProvider({ type: 'deepseek', deepseekApiKey: 'k-d', deepseekBaseUrl: 'https://ds.example' }).completeSync(context)

    expect(openaiCtorMock.mock.calls[0][0].baseURL).toBe('https://ds.example')
  })
})

describe('completeSync', () => {
  const context: BuiltContext = { system: '', messages: [{ role: 'user', content: 'hi' }] }

  it('anthropic 类型下调用 client.messages.create（而不是 .stream），并从多个 text block 拼接返回值', async () => {
    anthropicCreateMock.mockResolvedValue({
      content: [
        { type: 'text', text: 'hello ' },
        { type: 'tool_use', id: 't1', name: 'noop', input: {} },
        { type: 'text', text: 'world' },
      ],
    })

    const config: ModelConfig = { type: 'anthropic', modelName: 'claude-3', anthropicApiKey: 'key' }
    const provider = createModelProvider(config)
    const signal = new AbortController().signal

    const result = await provider.completeSync(context, { maxTokens: 500, signal })

    expect(result).toBe('hello world')
    expect(anthropicStreamMock).not.toHaveBeenCalled()
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1)
    const [params, requestOptions] = anthropicCreateMock.mock.calls[0]
    expect(params.model).toBe('claude-3')
    expect(params.max_tokens).toBe(500)
    expect(params.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(requestOptions).toEqual({ signal })
  })

  it('openai 类型下 stream 为 false，读取 choices[0].message.content，signal 作为请求选项传入', async () => {
    openaiCreateMock.mockResolvedValue(openaiCompletion('openai reply'))

    const provider = createModelProvider({ type: 'openai', modelName: 'gpt-4o-mini', openaiApiKey: 'key' })
    const signal = new AbortController().signal

    const result = await provider.completeSync(context, { signal })

    expect(result).toBe('openai reply')
    expect(openaiCreateMock).toHaveBeenCalledTimes(1)
    const [body, requestOptions] = openaiCreateMock.mock.calls[0]
    expect(body.stream).toBe(false)
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(requestOptions).toEqual({ signal })
  })

  it('ollama 类型下请求体 stream 为 false，解析一次性 JSON 的 choices[0].message.content', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeNonStreamResponse('ollama reply'))
    vi.stubGlobal('fetch', fetchSpy)

    const config: ModelConfig = { type: 'ollama', ollamaModel: 'qwen3' }
    const provider = createModelProvider(config)

    const result = await provider.completeSync(context)

    expect(result).toBe('ollama reply')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, options] = fetchSpy.mock.calls[0]
    expect(url).toContain('/v1/chat/completions')
    const body = JSON.parse(options.body)
    expect(body.stream).toBe(false)
  })

  it('deepseek 类型下 stream 为 false，读取 choices[0].message.content', async () => {
    openaiCreateMock.mockResolvedValue(openaiCompletion('deepseek reply'))

    const provider = createModelProvider({ type: 'deepseek', deepseekApiKey: 'sk-deepseek', modelName: 'deepseek-v4-pro' })

    const result = await provider.completeSync(context)

    expect(result).toBe('deepseek reply')
    const [body] = openaiCreateMock.mock.calls[0]
    expect(body.model).toBe('deepseek-v4-pro')
    expect(body.stream).toBe(false)
  })
})

describe('流式', () => {
  const context: BuiltContext = { system: 'sys', messages: [{ role: 'user', content: 'hi' }] }

  it('openai 流式：拼接 choices[0].delta.content，system 作为首条消息，signal 作为请求选项传入', async () => {
    openaiCreateMock.mockResolvedValue(openaiStream('hel', 'lo'))
    const provider = createModelProvider({ type: 'openai', openaiApiKey: 'key' })
    const signal = new AbortController().signal

    let text = ''
    for await (const chunk of provider.complete(context, { signal })) text += chunk

    expect(text).toBe('hello')
    const [body, requestOptions] = openaiCreateMock.mock.calls[0]
    expect(body.stream).toBe(true)
    expect(body.messages).toEqual([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }])
    expect(requestOptions).toEqual({ signal, timeout: 30000 })
  })

  it('deepseek 流式同样带 30 秒超时', async () => {
    openaiCreateMock.mockResolvedValue(openaiStream('hi'))
    const provider = createModelProvider({ type: 'deepseek', deepseekApiKey: 'key' })

    for await (const chunk of provider.complete(context)) void chunk

    expect(openaiCreateMock.mock.calls[0][1]).toEqual({ signal: undefined, timeout: 30000 })
  })

  it('anthropic 流式的 stream 调用带 30 秒超时，且不走 create', async () => {
    anthropicStreamMock.mockResolvedValue((async function* () {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }
    })())
    const provider = createModelProvider({ type: 'anthropic', modelName: 'claude-3', anthropicApiKey: 'key' })
    const signal = new AbortController().signal

    let text = ''
    for await (const chunk of provider.complete(context, { signal })) text += chunk

    expect(text).toBe('hi')
    expect(anthropicCreateMock).not.toHaveBeenCalled()
    expect(anthropicStreamMock.mock.calls[0][1]).toEqual({ signal, timeout: 30000 })
  })

  it('deepseek 流式：拼接 choices[0].delta.content', async () => {
    openaiCreateMock.mockResolvedValue(openaiStream('a', 'b', 'c'))
    const provider = createModelProvider({ type: 'deepseek', deepseekApiKey: 'sk-deepseek' })

    let text = ''
    for await (const chunk of provider.complete(context)) text += chunk

    expect(text).toBe('abc')
    expect(openaiCreateMock.mock.calls[0][0].stream).toBe(true)
  })
})

describe('默认模型名', () => {
  it('deepseek 未配置 modelName 时使用 deepseek-v4-flash', async () => {
    openaiCreateMock.mockResolvedValue(openaiStream('hi'))
    await drain(createModelProvider({ type: 'deepseek', deepseekApiKey: 'sk-deepseek' }))

    expect(openaiCreateMock.mock.calls[0][0].model).toBe('deepseek-v4-flash')
  })

  it('openai 未配置 modelName 时使用 gpt-4o', async () => {
    openaiCreateMock.mockResolvedValue(openaiStream('hi'))
    await drain(createModelProvider({ type: 'openai', openaiApiKey: 'key' }))

    expect(openaiCreateMock.mock.calls[0][0].model).toBe('gpt-4o')
  })
})

describe('provider 专属请求体（response_format / max_completion_tokens / thinking）', () => {
  const context: BuiltContext = { system: '', messages: [{ role: 'user', content: 'hi' }] }

  it('openai：请求体用 max_completion_tokens，不带 max_tokens / thinking，jsonMode 未传时无 response_format', async () => {
    openaiCreateMock.mockResolvedValue(openaiStream('hi'))
    await drainWith(createModelProvider({ type: 'openai', modelName: 'gpt-4o-mini', openaiApiKey: 'key' }), context, { maxTokens: 500 })

    const [body] = openaiCreateMock.mock.calls[0]
    expect(body.max_completion_tokens).toBe(500)
    expect(body.max_tokens).toBeUndefined()
    expect(body.thinking).toBeUndefined()
    expect(body.response_format).toBeUndefined()
  })

  it('openai：jsonMode 为 true 时带 response_format: json_object', async () => {
    openaiCreateMock.mockResolvedValue(openaiStream('hi'))
    await drainWith(createModelProvider({ type: 'openai', modelName: 'gpt-4o-mini', openaiApiKey: 'key' }), context, { jsonMode: true })

    expect(openaiCreateMock.mock.calls[0][0].response_format).toEqual({ type: 'json_object' })
  })

  it('deepseek：始终带 thinking: disabled，用 max_tokens，jsonMode 未传时无 response_format', async () => {
    openaiCreateMock.mockResolvedValue(openaiStream('hi'))
    await drainWith(createModelProvider({ type: 'deepseek', deepseekApiKey: 'sk-deepseek' }), context, {})

    const [body] = openaiCreateMock.mock.calls[0]
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.max_tokens).toBe(1000)
    expect(body.max_completion_tokens).toBeUndefined()
    expect(body.response_format).toBeUndefined()
  })

  it('deepseek：jsonMode 为 true 时也不带 response_format，thinking 仍存在', async () => {
    openaiCreateMock.mockResolvedValue(openaiStream('hi'))
    await drainWith(createModelProvider({ type: 'deepseek', deepseekApiKey: 'sk-deepseek' }), context, { jsonMode: true })

    const [body] = openaiCreateMock.mock.calls[0]
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.response_format).toBeUndefined()
  })

  it('ollama 分支：不带 thinking，max_tokens 参数名不变，jsonMode 为 true 时带 response_format', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeStreamResponse())
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createModelProvider({ type: 'ollama', ollamaModel: 'qwen3' })

    for await (const _chunk of provider.complete(context, { jsonMode: true })) {
      // 只需要触发 fetch 调用
    }

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.thinking).toBeUndefined()
    expect(body.max_tokens).toBe(1000)
    expect(body.max_completion_tokens).toBeUndefined()
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.reasoning_effort).toBe('none')
  })

  it('ollama 分支：未传 jsonMode 时仍带 reasoning_effort: none，不带 response_format', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeStreamResponse())
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createModelProvider({ type: 'ollama', ollamaModel: 'qwen3' })

    for await (const _chunk of provider.complete(context)) {
      // 只需要触发 fetch 调用
    }

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.reasoning_effort).toBe('none')
    expect(body.response_format).toBeUndefined()
  })

  it('completeSync 路径同样生效：openai 用 max_completion_tokens 并带 response_format', async () => {
    openaiCreateMock.mockResolvedValue(openaiCompletion('reply'))
    await createModelProvider({ type: 'openai', modelName: 'o1', openaiApiKey: 'key' }).completeSync(context, { maxTokens: 200, jsonMode: true })

    const [body] = openaiCreateMock.mock.calls[0]
    expect(body.max_completion_tokens).toBe(200)
    expect(body.max_tokens).toBeUndefined()
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('completeSync 路径同样生效：deepseek 始终带 thinking: disabled', async () => {
    openaiCreateMock.mockResolvedValue(openaiCompletion('reply'))
    await createModelProvider({ type: 'deepseek', deepseekApiKey: 'sk-deepseek' }).completeSync(context)

    expect(openaiCreateMock.mock.calls[0][0].thinking).toEqual({ type: 'disabled' })
  })
})

describe('resolveMaxTokens 三级 fallback', () => {
  const context: BuiltContext = { system: '', messages: [{ role: 'user', content: 'hi' }] }

  it('调用方显式传入 maxTokens 时优先生效，即便 provider 自身配置了另一个值', async () => {
    openaiCreateMock.mockResolvedValue(openaiCompletion('reply'))
    const provider = createModelProvider({ type: 'openai', modelName: 'gpt-4o-mini', openaiApiKey: 'key', maxTokens: 2000 })

    await provider.completeSync(context, { maxTokens: 500 })

    expect(openaiCreateMock.mock.calls[0][0].max_completion_tokens).toBe(500)
  })

  it('调用方未传 maxTokens 时使用 provider 自身配置的 maxTokens', async () => {
    openaiCreateMock.mockResolvedValue(openaiCompletion('reply'))
    const provider = createModelProvider({ type: 'openai', modelName: 'gpt-4o-mini', openaiApiKey: 'key', maxTokens: 2000 })

    await provider.completeSync(context)

    expect(openaiCreateMock.mock.calls[0][0].max_completion_tokens).toBe(2000)
  })

  it('调用方未传 maxTokens 且 provider 自身也未配置时，回落到默认值 1000', async () => {
    openaiCreateMock.mockResolvedValue(openaiCompletion('reply'))
    const provider = createModelProvider({ type: 'openai', modelName: 'gpt-4o-mini', openaiApiKey: 'key' })

    await provider.completeSync(context)

    expect(openaiCreateMock.mock.calls[0][0].max_completion_tokens).toBe(1000)
  })
})

describe('失败响应体读取（describeErrorResponse）', () => {
  const context: BuiltContext = { system: '', messages: [{ role: 'user', content: 'hi' }] }
  const ollamaConfig: ModelConfig = { type: 'ollama', ollamaModel: 'qwen3' }

  it('well-formed JSON error 对象：从 error.message 提取诊断信息，而不是只有状态行', async () => {
    const errorBody = JSON.stringify({
      error: { message: 'Invalid model ID: gpt-99', type: 'invalid_request_error', code: 'model_not_found' },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeErrorResponse(400, 'Bad Request', errorBody)))
    const provider = createModelProvider(ollamaConfig)

    await expect(provider.completeSync(context)).rejects.toThrow(
      'OpenAI API error: 400 Bad Request - Invalid model ID: gpt-99'
    )
  })

  it('非 JSON body：解析失败时原样展示原始文本，而不是丢弃', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      fakeErrorResponse(502, 'Bad Gateway', '<html><body>Bad Gateway</body></html>')
    ))
    const provider = createModelProvider(ollamaConfig)

    await expect(provider.completeSync(context)).rejects.toThrow(
      'OpenAI API error: 502 Bad Gateway - <html><body>Bad Gateway</body></html>'
    )
  })

  it('空 body：退回状态行本身，不拼接多余的 " - "', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeErrorResponse(500, 'Internal Server Error', '')))
    const provider = createModelProvider(ollamaConfig)

    let caught: Error | undefined
    try {
      await provider.completeSync(context)
    } catch (err) {
      caught = err as Error
    }
    expect(caught?.message).toBe('OpenAI API error: 500 Internal Server Error')
  })

  it('超长 body：截断到 500 字符并加省略号，不把整段塞进异常信息', async () => {
    const longMessage = 'x'.repeat(2000)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      fakeErrorResponse(400, 'Bad Request', JSON.stringify({ error: { message: longMessage } }))
    ))
    const provider = createModelProvider(ollamaConfig)

    let caught: Error | undefined
    try {
      await provider.completeSync(context)
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeDefined()
    const detail = caught!.message.slice('OpenAI API error: 400 Bad Request - '.length)
    expect(detail.length).toBe(501)
    expect(detail.endsWith('…')).toBe(true)
  })

  it('流式路径（complete）同样读取失败响应体，不只是非流式路径独有', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      fakeErrorResponse(429, 'Too Many Requests', JSON.stringify({ error: { message: 'Rate limit exceeded' } }))
    ))
    const provider = createModelProvider(ollamaConfig)

    await expect(drain(provider)).rejects.toThrow(
      'OpenAI API error: 429 Too Many Requests - Rate limit exceeded'
    )
  })
})

describe('缺失 API Key 时调用前失败', () => {
  const context: BuiltContext = { system: '', messages: [{ role: 'user', content: 'hi' }] }

  function expectNoSdkCall(): void {
    expect(anthropicCtorMock).not.toHaveBeenCalled()
    expect(openaiCtorMock).not.toHaveBeenCalled()
    expect(anthropicCreateMock).not.toHaveBeenCalled()
    expect(anthropicStreamMock).not.toHaveBeenCalled()
    expect(openaiCreateMock).not.toHaveBeenCalled()
  }

  it('构造 provider 时不检查 key（缺 key 也不抛）', () => {
    expect(() => createModelProvider({ type: 'openai' })).not.toThrow()
    expect(() => createModelProvider({ type: 'deepseek' })).not.toThrow()
    expect(() => createModelProvider({ type: 'anthropic' })).not.toThrow()
  })

  it('openai 缺 key：completeSync 与 complete 都抛配置错误，SDK 构造函数未被调用', async () => {
    const provider = createModelProvider({ type: 'openai', modelName: 'gpt-4o-mini' })

    await expect(provider.completeSync(context)).rejects.toThrow('[ModelProvider] OpenAI API key is not configured')
    await expect(drain(provider)).rejects.toThrow('[ModelProvider] OpenAI API key is not configured')
    expectNoSdkCall()
  })

  it('openai key 为空串同样视为缺失', async () => {
    const provider = createModelProvider({ type: 'openai', openaiApiKey: '' })

    await expect(provider.completeSync(context)).rejects.toThrow('[ModelProvider] OpenAI API key is not configured')
    expectNoSdkCall()
  })

  it('deepseek 缺 key：completeSync 与 complete 都抛配置错误，SDK 构造函数未被调用', async () => {
    const provider = createModelProvider({ type: 'deepseek' })

    await expect(provider.completeSync(context)).rejects.toThrow('[ModelProvider] DeepSeek API key is not configured')
    await expect(drain(provider)).rejects.toThrow('[ModelProvider] DeepSeek API key is not configured')
    expectNoSdkCall()
  })

  it('anthropic 缺 key：completeSync 与 complete 都抛配置错误，SDK 构造函数未被调用', async () => {
    const provider = createModelProvider({ type: 'anthropic', modelName: 'claude-3' })

    await expect(provider.completeSync(context)).rejects.toThrow('[ModelProvider] Anthropic API key is not configured')
    await expect(drain(provider)).rejects.toThrow('[ModelProvider] Anthropic API key is not configured')
    expectNoSdkCall()
  })

  it('preset 覆盖且角色缺 key：即使全局有 key 也失败，不回落到全局 key', async () => {
    const provider = createModelProviderForPreset(
      fakePreset({ modelType: 'openai', modelName: 'gpt-4o-mini' }),
      { type: 'ollama', openaiApiKey: 'global-key', openaiApiKeyFromEnv: false },
      noCredentials
    )

    await expect(provider.completeSync(context)).rejects.toThrow('[ModelProvider] OpenAI API key is not configured')
    expectNoSdkCall()
  })

  it('preset 覆盖且角色 FromEnv 关闭：全局 FromEnv 开启也不影响，使用角色自己的 key', async () => {
    openaiCreateMock.mockResolvedValue(openaiCompletion('ok'))
    const provider = createModelProviderForPreset(
      fakePreset({ modelType: 'openai', modelName: 'gpt-4o-mini' }),
      { type: 'ollama', openaiApiKey: 'global-key', openaiApiKeyFromEnv: true },
      credentialsWith({ openai: { apiKey: 'role-key', fromEnv: false } })
    )

    await provider.completeSync(context)

    expect(openaiCtorMock.mock.calls[0][0].apiKey).toBe('role-key')
  })

  it('preset 覆盖且角色 FromEnv 开启但环境缺失：抛环境变量不可用错误，不使用角色或全局已保存 key', async () => {
    delete process.env.OPENAI_API_KEY
    wipeCredentialEnv()
    const provider = createModelProviderForPreset(
      fakePreset({ modelType: 'openai', modelName: 'gpt-4o-mini' }),
      { type: 'ollama', openaiApiKey: 'global-key' },
      credentialsWith({ openai: { apiKey: 'role-key', fromEnv: true } })
    )

    await expect(provider.completeSync(context)).rejects.toThrow('[ModelProvider] OpenAI API key environment variable is not available')
    expectNoSdkCall()
  })

  it('preset 覆盖且角色 FromEnv 开启且环境有 key：使用环境变量 key', async () => {
    process.env.OPENAI_API_KEY = 'sk-from-env'
    wipeCredentialEnv()
    openaiCreateMock.mockResolvedValue(openaiCompletion('ok'))
    const provider = createModelProviderForPreset(
      fakePreset({ modelType: 'openai', modelName: 'gpt-4o-mini' }),
      { type: 'ollama', openaiApiKey: 'global-key' },
      credentialsWith({ openai: { fromEnv: true } })
    )

    await provider.completeSync(context)
    delete process.env.OPENAI_API_KEY
    wipeCredentialEnv()

    expect(openaiCtorMock.mock.calls[0][0].apiKey).toBe('sk-from-env')
  })

  it('ollama 未配置任何凭据字段时仍正常发起请求（本地端点不认证）', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeNonStreamResponse('ollama reply'))
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createModelProvider({ type: 'ollama' })

    const result = await provider.completeSync(context)

    expect(result).toBe('ollama reply')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('resolveApiKey', () => {
  it('FromEnv 开启且环境暂存值存在：返回暂存值，忽略已保存的 key', () => {
    const config: ModelConfig = { type: 'openai', openaiApiKey: 'saved', openaiApiKeyFromEnv: true }

    expect(resolveApiKey(config, 'openai', () => 'from-env')).toBe('from-env')
  })

  it('FromEnv 开启但暂存值为空：抛环境变量不可用错误，即使有已保存的 key', () => {
    const config: ModelConfig = { type: 'deepseek', deepseekApiKey: 'saved', deepseekApiKeyFromEnv: true }

    expect(() => resolveApiKey(config, 'deepseek', () => '')).toThrow('[ModelProvider] DeepSeek API key environment variable is not available')
  })

  it('FromEnv 关闭且有已保存的 key：返回已保存的 key，不读环境', () => {
    const config: ModelConfig = { type: 'anthropic', anthropicApiKey: 'saved', anthropicApiKeyFromEnv: false }
    const readEnvKey = vi.fn(() => 'from-env')

    expect(resolveApiKey(config, 'anthropic', readEnvKey)).toBe('saved')
    expect(readEnvKey).not.toHaveBeenCalled()
  })

  it('FromEnv 关闭且没有已保存的 key：抛未配置错误', () => {
    expect(() => resolveApiKey({ type: 'anthropic' }, 'anthropic', () => 'from-env')).toThrow('[ModelProvider] Anthropic API key is not configured')
    expect(() => resolveApiKey({ type: 'openai', openaiApiKey: '' }, 'openai', () => 'from-env')).toThrow('[ModelProvider] OpenAI API key is not configured')
  })
})

describe('调用时按 FromEnv 标记解析 key', () => {
  const context: BuiltContext = { system: '', messages: [{ role: 'user', content: 'hi' }] }
  afterEach(() => {
    delete process.env.OPENAI_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    wipeCredentialEnv()
  })

  it('FromEnv 开启且环境里有 key：SDK 用暂存的 key 构造', async () => {
    process.env.OPENAI_API_KEY = 'sk-from-env'
    wipeCredentialEnv()
    openaiCreateMock.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] })

    await createModelProvider({ type: 'openai', openaiApiKey: 'saved', openaiApiKeyFromEnv: true }).completeSync(context)

    expect(openaiCtorMock.mock.calls[0][0].apiKey).toBe('sk-from-env')
  })

  it('FromEnv 开启但环境里没有 key：抛环境变量不可用错误，不构造 SDK 客户端也不发请求', async () => {
    delete process.env.OPENAI_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    wipeCredentialEnv()
    const openaiProvider = createModelProvider({ type: 'openai', openaiApiKey: 'saved', openaiApiKeyFromEnv: true })
    const anthropicProvider = createModelProvider({ type: 'anthropic', modelName: 'claude-3', anthropicApiKey: 'saved', anthropicApiKeyFromEnv: true })

    await expect(openaiProvider.completeSync(context)).rejects.toThrow('[ModelProvider] OpenAI API key environment variable is not available')
    await expect(drain(anthropicProvider)).rejects.toThrow('[ModelProvider] Anthropic API key environment variable is not available')

    expect(openaiCtorMock).not.toHaveBeenCalled()
    expect(anthropicCtorMock).not.toHaveBeenCalled()
    expect(openaiCreateMock).not.toHaveBeenCalled()
    expect(anthropicStreamMock).not.toHaveBeenCalled()
  })
})

describe('Ollama 空地址使用默认地址', () => {
  const context: BuiltContext = { system: '', messages: [{ role: 'user', content: 'hi' }] }

  it.each([
    ['未设置', undefined],
    ['空串', ''],
  ])('ollamaBaseUrl %s：completeSync 与 complete 都请求默认地址', async (_label, ollamaBaseUrl) => {
    const syncFetch = vi.fn().mockResolvedValue(fakeNonStreamResponse('ok'))
    vi.stubGlobal('fetch', syncFetch)
    const provider = createModelProvider({ type: 'ollama', ollamaModel: 'qwen3', ollamaBaseUrl })

    await provider.completeSync(context)

    expect(syncFetch.mock.calls[0][0]).toBe('http://localhost:11434/v1/chat/completions')

    const streamFetch = vi.fn().mockResolvedValue(fakeStreamResponse())
    vi.stubGlobal('fetch', streamFetch)
    await drain(provider)

    expect(streamFetch.mock.calls[0][0]).toBe('http://localhost:11434/v1/chat/completions')
  })

  it('ollamaBaseUrl 非空时使用配置的地址', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeNonStreamResponse('ok'))
    vi.stubGlobal('fetch', fetchSpy)

    await createModelProvider({ type: 'ollama', ollamaModel: 'qwen3', ollamaBaseUrl: 'http://10.0.0.2:11434' }).completeSync(context)

    expect(fetchSpy.mock.calls[0][0]).toBe('http://10.0.0.2:11434/v1/chat/completions')
  })
})
