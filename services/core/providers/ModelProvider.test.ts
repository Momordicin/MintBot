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

import type { TurnMessage } from './ModelProvider.js'

const { createModelProviderForPreset, createSummaryModelProviderForPreset, createModelProvider, resolveApiKey, stripThinkTags } = await import('./ModelProvider.js')
const { wipeCredentialEnv } = await import('./envCredentials.js')

function fakePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    presetId: 'p1',
    name: 'test',
    characterId: 'c1',
    modelType: 'ollama',
    modelName: 'llama3',
    summaryModelType: null,
    summaryModelName: null,
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

  it('ollama 分支：不带 thinking / max_tokens / reasoning_effort，jsonMode 为 true 时带 response_format', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeStreamResponse())
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createModelProvider({ type: 'ollama', ollamaModel: 'qwen3' })

    for await (const _chunk of provider.complete(context, { jsonMode: true })) {
      // 只需要触发 fetch 调用
    }

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.thinking).toBeUndefined()
    expect(body.max_tokens).toBeUndefined()
    expect(body.max_completion_tokens).toBeUndefined()
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('ollama 分支：显式传入 maxTokens 也不带 max_tokens，未传 jsonMode 时不带 response_format', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeStreamResponse())
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createModelProvider({ type: 'ollama', ollamaModel: 'qwen3' })

    for await (const _chunk of provider.complete(context, { maxTokens: 300 })) {
      // 只需要触发 fetch 调用
    }

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.max_tokens).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.response_format).toBeUndefined()
  })

  it('ollama completeSync：请求体不带 max_tokens / reasoning_effort，jsonMode 时带 response_format', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeNonStreamResponse('ok'))
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createModelProvider({ type: 'ollama', ollamaModel: 'qwen3', maxTokens: 400 })

    await provider.completeSync(context, { maxTokens: 300, jsonMode: true })

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.max_tokens).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.response_format).toEqual({ type: 'json_object' })
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

describe('createSummaryModelProviderForPreset', () => {
  const context: BuiltContext = { system: '', messages: [{ role: 'user', content: 'hi' }] }
  const globalConfig: ModelConfig = {
    type: 'ollama',
    openaiApiKey: 'global-openai',
    deepseekApiKey: 'global-deepseek',
    ollamaBaseUrl: 'http://global-ollama:11434',
  }

  it('摘要模型为 null 时沿用角色的对话模型与对话 key，不读取摘要 key', async () => {
    openaiCreateMock.mockResolvedValue(openaiCompletion('ok'))
    const preset = fakePreset({ modelType: 'openai', modelName: 'gpt-4o', summaryModelType: null, summaryModelName: null })

    await createSummaryModelProviderForPreset(
      preset,
      globalConfig,
      credentialsWith({ openai: { apiKey: 'chat-key', fromEnv: false, summaryApiKey: 'summary-key', summaryFromEnv: false } })
    ).completeSync(context)

    expect(openaiCtorMock.mock.calls[0][0].apiKey).toBe('chat-key')
    expect(openaiCreateMock.mock.calls[0][0].model).toBe('gpt-4o')
  })

  it('摘要模型已设置：使用摘要模型名与摘要 key，即使同一 provider 也不用对话 key', async () => {
    openaiCreateMock.mockResolvedValue(openaiCompletion('ok'))
    const preset = fakePreset({ modelType: 'openai', modelName: 'gpt-4o', summaryModelType: 'openai', summaryModelName: 'gpt-4o-mini' })

    await createSummaryModelProviderForPreset(
      preset,
      globalConfig,
      credentialsWith({ openai: { apiKey: 'chat-key', fromEnv: false, summaryApiKey: 'summary-key', summaryFromEnv: false } })
    ).completeSync(context)

    expect(openaiCtorMock.mock.calls[0][0].apiKey).toBe('summary-key')
    expect(openaiCreateMock.mock.calls[0][0].model).toBe('gpt-4o-mini')
  })

  it('摘要 provider 与对话 provider 不同：只用摘要 provider 的摘要 key，不用全局 key', async () => {
    openaiCreateMock.mockResolvedValue(openaiCompletion('ok'))
    const preset = fakePreset({ modelType: 'openai', modelName: 'gpt-4o', summaryModelType: 'deepseek', summaryModelName: 'deepseek-v4-flash' })

    await createSummaryModelProviderForPreset(
      preset,
      globalConfig,
      credentialsWith({
        openai: { apiKey: 'chat-key', fromEnv: false },
        deepseek: { fromEnv: false, summaryApiKey: 'ds-summary-key', summaryFromEnv: false },
      })
    ).completeSync(context)

    expect(openaiCtorMock.mock.calls[0][0].apiKey).toBe('ds-summary-key')
    expect(openaiCreateMock.mock.calls[0][0].model).toBe('deepseek-v4-flash')
  })

  it('摘要 key 缺失时抛配置错误，不回落到对话 key 或全局 key', async () => {
    const preset = fakePreset({ modelType: 'openai', modelName: 'gpt-4o', summaryModelType: 'openai', summaryModelName: 'gpt-4o-mini' })

    await expect(createSummaryModelProviderForPreset(
      preset,
      globalConfig,
      credentialsWith({ openai: { apiKey: 'chat-key', fromEnv: false } })
    ).completeSync(context)).rejects.toThrow('[ModelProvider] OpenAI API key is not configured')
    expect(openaiCtorMock).not.toHaveBeenCalled()
  })

  it('摘要 summaryFromEnv 开启时使用环境 key，环境缺失则抛错而不用对话 key', async () => {
    process.env.OPENAI_API_KEY = 'sk-from-env'
    wipeCredentialEnv()
    openaiCreateMock.mockResolvedValue(openaiCompletion('ok'))
    const preset = fakePreset({ modelType: 'openai', modelName: 'gpt-4o', summaryModelType: 'openai', summaryModelName: 'gpt-4o-mini' })
    const credentials = credentialsWith({ openai: { apiKey: 'chat-key', fromEnv: false, summaryFromEnv: true } })

    await createSummaryModelProviderForPreset(preset, globalConfig, credentials).completeSync(context)
    expect(openaiCtorMock.mock.calls[0][0].apiKey).toBe('sk-from-env')

    delete process.env.OPENAI_API_KEY
    wipeCredentialEnv()
    await expect(createSummaryModelProviderForPreset(preset, globalConfig, credentials).completeSync(context))
      .rejects.toThrow('[ModelProvider] OpenAI API key environment variable is not available')
  })

  it('摘要模型为 ollama：摘要模型名写入 ollamaModel，使用全局 Ollama 地址，不需要 key', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeNonStreamResponse('ollama reply'))
    vi.stubGlobal('fetch', fetchSpy)
    const preset = fakePreset({ modelType: 'openai', modelName: 'gpt-4o', summaryModelType: 'ollama', summaryModelName: 'qwen3-summary' })

    const result = await createSummaryModelProviderForPreset(preset, globalConfig, noCredentials).completeSync(context)

    expect(result).toBe('ollama reply')
    const [url, options] = fetchSpy.mock.calls[0]
    expect(url).toContain('http://global-ollama:11434')
    expect(JSON.parse(options.body).model).toBe('qwen3-summary')
  })

  it('角色使用全局配置时忽略摘要字段，完全使用全局配置', async () => {
    openaiCreateMock.mockResolvedValue(openaiCompletion('ok'))
    const global: ModelConfig = { type: 'openai', modelName: 'global-model', openaiApiKey: 'global-key' }
    const preset = fakePreset({ modelType: null, modelName: null, summaryModelType: 'deepseek', summaryModelName: 'deepseek-v4-flash' })

    await createSummaryModelProviderForPreset(
      preset,
      global,
      credentialsWith({ deepseek: { fromEnv: false, summaryApiKey: 'ds-summary-key', summaryFromEnv: false } })
    ).completeSync(context)

    expect(openaiCtorMock.mock.calls[0][0].apiKey).toBe('global-key')
    expect(openaiCreateMock.mock.calls[0][0].model).toBe('global-model')
  })
})

function sseResponse(contents: string[]): Response {
  const body = contents
    .map(content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
    .join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200 })
}

async function collectOllama(contents: string[]): Promise<string> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(contents)))
  const provider = createModelProvider({ type: 'ollama', ollamaModel: 'qwen3' })
  let text = ''
  for await (const chunk of provider.complete({ system: '', messages: [{ role: 'user', content: 'hi' }] })) {
    text += chunk
  }
  return text
}

describe('Ollama 只保留最终答案（过滤 <think>）', () => {
  const context: BuiltContext = { system: '', messages: [{ role: 'user', content: 'hi' }] }

  it('流式：标签被拆到多个分片时仍能过滤', async () => {
    expect(await collectOllama(['<th', 'ink>想', '一想</thi', 'nk>答', '案'])).toBe('答案')
  })

  it('流式：多段 think 都被去掉', async () => {
    expect(await collectOllama(['<think>a</think>甲<think>b</think>乙'])).toBe('甲乙')
  })

  it('流式：未闭合的 think 之后的内容全部丢弃', async () => {
    expect(await collectOllama(['答', '案<think>没想完', '还在想'])).toBe('答案')
  })

  it('流式：无标签原样输出，含看起来像标签开头的普通文字', async () => {
    expect(await collectOllama(['a < b', ' and <t', 'hing> ok'])).toBe('a < b and <thing> ok')
  })

  it('流式：流结束时缓存的疑似标签前缀按普通文字输出', async () => {
    expect(await collectOllama(['答案<thi'])).toBe('答案<thi')
  })

  it('非流式：对整段文字同样处理', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeNonStreamResponse('<think>想</think>答案<think>未完')))
    const result = await createModelProvider({ type: 'ollama', ollamaModel: 'qwen3' }).completeSync(context)
    expect(result).toBe('答案')
  })

  it('非流式：去掉后为空时返回空字符串', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeNonStreamResponse('<think>只有思考</think>')))
    const result = await createModelProvider({ type: 'ollama', ollamaModel: 'qwen3' }).completeSync(context)
    expect(result).toBe('')
  })

  it('非流式：无标签原样返回', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeNonStreamResponse('plain 1 < 2')))
    const result = await createModelProvider({ type: 'ollama', ollamaModel: 'qwen3' }).completeSync(context)
    expect(result).toBe('plain 1 < 2')
  })

  it('非流式：孤立的 </think> 在开头，丢掉它之前的内容', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeNonStreamResponse('</think>答案')))
    const result = await createModelProvider({ type: 'ollama', ollamaModel: 'qwen3' }).completeSync(context)
    expect(result).toBe('答案')
  })

  it('流式：孤立的 </think> 原样输出，由调用方统一过滤', async () => {
    const raw = await collectOllama(['想', '一想</thi', 'nk>答案'])
    expect(raw).toBe('想一想</think>答案')
    expect(stripThinkTags(raw)).toBe('答案')
  })
})

describe('stripThinkTags', () => {
  it('孤立的 </think> 在开头：丢掉标签', () => {
    expect(stripThinkTags('</think>答案')).toBe('答案')
  })

  it('孤立的 </think> 在中间：丢掉它之前的所有内容', () => {
    expect(stripThinkTags('思考过程</think>答案')).toBe('答案')
  })

  it('多个孤立的 </think>：只保留最后一个之后的内容', () => {
    expect(stripThinkTags('a</think>b</think>c')).toBe('c')
  })

  it('孤立标签与成对标签混合', () => {
    expect(stripThinkTags('<think>x</think>甲</think>乙<think>y</think>丙')).toBe('乙丙')
    expect(stripThinkTags('甲</think>乙<think>c</think>丁')).toBe('乙丁')
  })

  it('孤立标签之后出现未闭合的 <think>：其后全部丢弃', () => {
    expect(stripThinkTags('想</think>答案<think>未完')).toBe('答案')
  })

  it('成对标签照旧去掉，无标签原样', () => {
    expect(stripThinkTags('<think>a</think>甲<think>b</think>乙')).toBe('甲乙')
    expect(stripThinkTags('plain 1 < 2')).toBe('plain 1 < 2')
  })

  it('过滤后去掉首尾空白', () => {
    expect(stripThinkTags('想一想</think>\n\n答案')).toBe('答案')
  })

  it('无标签时只去首尾空白，中间不变', () => {
    expect(stripThinkTags('  \n甲  乙\n丙 \n')).toBe('甲  乙\n丙')
  })
})

describe('Ollama 超时', () => {
  const context: BuiltContext = { system: '', messages: [{ role: 'user', content: 'hi' }] }
  const encoder = new TextEncoder()

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function stubTimeout(): AbortController {
    const timeoutController = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal)
    return timeoutController
  }

  function hangingFetch() {
    return vi.fn().mockImplementation((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason))
      })
    )
  }

  function controlledStreamFetch() {
    const handle: { controller?: ReadableStreamDefaultController<Uint8Array> } = {}
    const fetchMock = vi.fn().mockImplementation((_url: string, init: { signal: AbortSignal }) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          handle.controller = controller
          init.signal.addEventListener('abort', () => controller.error(init.signal.reason))
        },
      })
      return Promise.resolve(new Response(stream, { status: 200 }))
    })
    const push = (text: string) => handle.controller!.enqueue(encoder.encode(text))
    const sse = (content: string) => push(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
    return { fetchMock, push, sse }
  }

  function collect(provider: ReturnType<typeof createModelProvider>, signal?: AbortSignal): Promise<string> {
    return (async () => {
      let out = ''
      for await (const chunk of provider.complete(context, { signal })) out += chunk
      return out
    })()
  }

  const ollama = () => createModelProvider({ type: 'ollama', ollamaModel: 'qwen3' })

  it('流式：120 秒内没有任何输出，以 "Ollama produced no output within 120s" 失败，调用方信号未被取消', async () => {
    vi.useFakeTimers()
    const { fetchMock } = controlledStreamFetch()
    vi.stubGlobal('fetch', fetchMock)
    const caller = new AbortController()

    const assertion = expect(collect(ollama(), caller.signal)).rejects.toThrow('Ollama produced no output within 120s')
    await vi.advanceTimersByTimeAsync(119999)
    expect(caller.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    await assertion
    expect(caller.signal.aborted).toBe(false)
  })

  it('流式：请求发出后一直没有响应时同样按 120 秒无输出判定失败', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', hangingFetch())

    const assertion = expect(collect(ollama())).rejects.toThrow('Ollama produced no output within 120s')
    await vi.advanceTimersByTimeAsync(120000)

    await assertion
  })

  it('流式：数据持续到达时总时长超过 120 秒也不超时，完整返回内容', async () => {
    vi.useFakeTimers()
    const { fetchMock, push, sse } = controlledStreamFetch()
    vi.stubGlobal('fetch', fetchMock)

    const result = collect(ollama())
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 10; i++) {
      sse(String(i))
      await vi.advanceTimersByTimeAsync(30000)
    }
    push('data: [DONE]\n\n')

    await expect(result).resolves.toBe('0123456789')
  })

  it('流式：收到数据后思考内容或无法解析的数据同样刷新计时', async () => {
    vi.useFakeTimers()
    const { fetchMock, push, sse } = controlledStreamFetch()
    vi.stubGlobal('fetch', fetchMock)

    const result = collect(ollama())
    await vi.advanceTimersByTimeAsync(0)
    sse('<think>')
    await vi.advanceTimersByTimeAsync(59000)
    push('data: not-json\n\n')
    await vi.advanceTimersByTimeAsync(59000)
    sse('</think>答')
    await vi.advanceTimersByTimeAsync(59000)
    push('data: [DONE]\n\n')

    await expect(result).resolves.toBe('答')
  })

  it('流式：收到数据后停顿 60 秒，以 "Ollama stream stalled for 60s" 失败，调用方信号未被取消', async () => {
    vi.useFakeTimers()
    const { fetchMock, sse } = controlledStreamFetch()
    vi.stubGlobal('fetch', fetchMock)
    const caller = new AbortController()

    const assertion = expect(collect(ollama(), caller.signal)).rejects.toThrow('Ollama stream stalled for 60s')
    await vi.advanceTimersByTimeAsync(0)
    sse('hi')
    await vi.advanceTimersByTimeAsync(59999)
    expect(caller.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    await assertion
    expect(caller.signal.aborted).toBe(false)
  })

  it('流式：调用方主动取消不会被转换成超时错误，之后也不再触发超时', async () => {
    vi.useFakeTimers()
    const { fetchMock } = controlledStreamFetch()
    vi.stubGlobal('fetch', fetchMock)
    const caller = new AbortController()

    const assertion = expect(collect(ollama(), caller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(1000)
    caller.abort()

    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('completeSync：请求使用 300000ms 的超时信号', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const fetchSpy = vi.fn().mockResolvedValue(fakeNonStreamResponse('ok'))
    vi.stubGlobal('fetch', fetchSpy)

    await ollama().completeSync(context)

    expect(timeoutSpy).toHaveBeenCalledWith(300000)
    expect(fetchSpy.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  it('completeSync：超时后以含 "Ollama call timed out after 300s" 的错误失败，调用方信号未被置为已取消', async () => {
    const timeoutController = stubTimeout()
    vi.stubGlobal('fetch', hangingFetch())
    const caller = new AbortController()

    const pending = ollama().completeSync(context, { signal: caller.signal })
    timeoutController.abort(new DOMException('timed out', 'TimeoutError'))

    await expect(pending).rejects.toThrow('Ollama call timed out after 300s')
    expect(caller.signal.aborted).toBe(false)
  })

  it('completeSync：未传 signal 时只使用超时信号，超时照样失败', async () => {
    const timeoutController = stubTimeout()
    vi.stubGlobal('fetch', hangingFetch())

    const pending = ollama().completeSync(context)
    timeoutController.abort(new DOMException('timed out', 'TimeoutError'))

    await expect(pending).rejects.toThrow('Ollama call timed out after 300s')
  })

  it('completeSync：调用方主动取消以 AbortError 中止，调用方信号为已取消，超时信号未触发', async () => {
    const timeoutController = stubTimeout()
    vi.stubGlobal('fetch', hangingFetch())
    const caller = new AbortController()

    const pending = ollama().completeSync(context, { signal: caller.signal })
    caller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(caller.signal.aborted).toBe(true)
    expect(timeoutController.signal.aborted).toBe(false)
  })
})

describe('chatTurn：四家服务商的工具请求与返回转换', () => {
  const tool = {
    name: 'get_weather',
    description: '查天气',
    parameters: { type: 'object', properties: { period: { type: 'string' } }, required: ['period'] },
  }
  const messages: TurnMessage[] = [
    { role: 'user', content: '天气？' },
    { role: 'assistant', content: '我查一下', toolCalls: [{ id: 'c1', name: 'get_weather', args: { period: 'today' } }] },
    { role: 'tool', toolCallId: 'c1', content: '晴' },
  ]
  const request = { system: 'sys', messages, tools: [tool], maxTokens: 321, stream: false }
  const syncCalls = [{ id: 'c1', name: 'get_weather', args: { period: 'today' } }]
  const streamCalls = [
    { id: 'c1', name: 'get_weather', args: { period: 'today' } },
    { id: 'c2', name: 'get_weather', args: { period: 'tomorrow' } },
  ]

  const openaiWire = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '天气？' },
    {
      role: 'assistant',
      content: '我查一下',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"period":"today"}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: '晴' },
  ]
  const openaiTools = [{ type: 'function', function: { name: 'get_weather', description: '查天气', parameters: tool.parameters } }]

  async function* chunks(...items: unknown[]) {
    for (const item of items) yield item
  }

  const openaiSyncMessage = {
    choices: [{ message: { content: 'hi', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"period":"today"}' } }] } }],
  }
  const openaiStreamChunks = [
    { choices: [{ delta: { content: 'a' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_weather', arguments: '{"per' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'get_weather', arguments: '{"period"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'iod":"today"}' } }] } }] },
    { choices: [{ delta: { content: 'b', tool_calls: [{ index: 1, function: { arguments: ':"tomorrow"}' } }] } }] },
  ]

  function sse(items: unknown[]): Response {
    const body = items.map(item => `data: ${JSON.stringify(item)}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(body, { status: 200 })
  }

  const rows = [
    {
      name: 'openai',
      config: { type: 'openai', openaiApiKey: 'k', modelName: 'gpt-4o' } as ModelConfig,
      arrange(stream: boolean) {
        openaiCreateMock.mockResolvedValue(stream ? chunks(...openaiStreamChunks) : openaiSyncMessage)
      },
      sent: () => openaiCreateMock.mock.calls[0][0],
      expectWire(body: any) {
        expect(body.messages).toEqual(openaiWire)
        expect(body.tools).toEqual(openaiTools)
        expect(body.max_completion_tokens).toBe(321)
        expect(body.response_format).toBeUndefined()
      },
    },
    {
      name: 'deepseek',
      config: { type: 'deepseek', deepseekApiKey: 'k', modelName: 'deepseek-v4-flash' } as ModelConfig,
      arrange(stream: boolean) {
        openaiCreateMock.mockResolvedValue(stream ? chunks(...openaiStreamChunks) : openaiSyncMessage)
      },
      sent: () => openaiCreateMock.mock.calls[0][0],
      expectWire(body: any) {
        expect(body.messages).toEqual(openaiWire)
        expect(body.tools).toEqual(openaiTools)
        expect(body.max_tokens).toBe(321)
        expect(body.thinking).toEqual({ type: 'disabled' })
      },
    },
    {
      name: 'ollama',
      config: { type: 'ollama', ollamaModel: 'qwen3' } as ModelConfig,
      arrange(stream: boolean) {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream ? sse(openaiStreamChunks) : new Response(JSON.stringify(openaiSyncMessage), { status: 200 })))
      },
      sent: () => JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string),
      expectWire(body: any) {
        expect(body.messages).toEqual(openaiWire)
        expect(body.tools).toEqual(openaiTools)
        expect(body.model).toBe('qwen3')
        expect(body.response_format).toBeUndefined()
      },
    },
    {
      name: 'anthropic',
      config: { type: 'anthropic', anthropicApiKey: 'k', modelName: 'claude-x' } as ModelConfig,
      arrange(stream: boolean) {
        if (!stream) {
          anthropicCreateMock.mockResolvedValue({
            content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'c1', name: 'get_weather', input: { period: 'today' } }],
          })
          return
        }
        anthropicStreamMock.mockResolvedValue(chunks(
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } },
          { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'c1', name: 'get_weather', input: {} } },
          { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'c2', name: 'get_weather', input: {} } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"per' } },
          { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"period"' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'iod":"today"}' } },
          { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: ':"tomorrow"}' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'b' } },
        ))
      },
      sent: () => (anthropicCreateMock.mock.calls[0] ?? anthropicStreamMock.mock.calls[0])[0],
      expectWire(body: any) {
        expect(body.system).toBe('sys')
        expect(body.max_tokens).toBe(321)
        expect(body.tools).toEqual([{ name: 'get_weather', description: '查天气', input_schema: tool.parameters }])
        expect(body.messages).toEqual([
          { role: 'user', content: '天气？' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: '我查一下' },
              { type: 'tool_use', id: 'c1', name: 'get_weather', input: { period: 'today' } },
            ],
          },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '晴' }] },
        ])
      },
    },
  ]

  it.each(rows)('$name：非流式，请求带工具与工具结果，解析出文字和工具调用', async row => {
    row.arrange(false)

    const result = await createModelProvider(row.config).chatTurn(request)

    row.expectWire(row.sent())
    expect(result).toEqual({ text: 'hi', toolCalls: syncCalls })
  })

  it.each(rows)('$name：流式，请求格式相同，按编号拼接工具调用片段', async row => {
    row.arrange(true)

    const result = await createModelProvider(row.config).chatTurn({ ...request, stream: true })

    row.expectWire(row.sent())
    expect(result).toEqual({ text: 'ab', toolCalls: streamCalls })
  })

  it('anthropic：多个工具结果合并进同一条 user 消息，后面的用户消息接在其后', async () => {
    anthropicCreateMock.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })

    await createModelProvider({ type: 'anthropic', anthropicApiKey: 'k', modelName: 'claude-x' }).chatTurn({
      system: '',
      tools: [],
      stream: false,
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 't', args: {} }, { id: 'b', name: 't', args: {} }] },
        { role: 'tool', toolCallId: 'a', content: 'ra' },
        { role: 'tool', toolCallId: 'b', content: 'rb' },
        { role: 'user', content: '上限' },
      ],
    })

    const body = anthropicCreateMock.mock.calls[0][0]
    expect(body.system).toBeUndefined()
    expect(body.tools).toBeUndefined()
    expect(body.messages[1].content).toEqual([
      { type: 'tool_use', id: 'a', name: 't', input: {} },
      { type: 'tool_use', id: 'b', name: 't', input: {} },
    ])
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'ra' },
        { type: 'tool_result', tool_use_id: 'b', content: 'rb' },
        { type: 'text', text: '上限' },
      ],
    })
  })

  it.each([
    { name: 'openai', config: { type: 'openai', openaiApiKey: 'k' } as ModelConfig },
    { name: 'ollama', config: { type: 'ollama', ollamaModel: 'qwen3' } as ModelConfig },
  ])('$name：不带工具的请求不带 response_format', async row => {
    openaiCreateMock.mockResolvedValue(openaiSyncMessage)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(openaiSyncMessage), { status: 200 })))

    await createModelProvider(row.config).chatTurn({ ...request, tools: [] })

    const body = row.name === 'openai'
      ? openaiCreateMock.mock.calls[0][0]
      : JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string)
    expect(body.tools).toBeUndefined()
    expect(body.response_format).toBeUndefined()
  })
})
