import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Preset, ModelConfig, BuiltContext } from '../../../shared/types/index.js'

// completeSync 对 Anthropic 类型必须走 client.messages.create（非流式），而不是 messages.stream，
// 用 vi.hoisted 声明 mock 函数，供 vi.mock 工厂（会被提升到 import 之前）闭包引用
const { anthropicCreateMock, anthropicStreamMock } = vi.hoisted(() => ({
  anthropicCreateMock: vi.fn(),
  anthropicStreamMock: vi.fn(),
}))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreateMock, stream: anthropicStreamMock }
  },
}))

const { createModelProviderForPreset, createModelProvider } = await import('./ModelProvider.js')

function fakePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    presetId: 'p1',
    name: 'test',
    characterId: 'c1',
    modelType: 'ollama',
    modelName: 'llama3',
    displayConfig: { chatBgRgb: [15, 15, 20], chatBgOpacity: 0.65, themeMode: 'auto', accentRgb: [15, 15, 20], tintStrength: 0 },
    systemPrompt: 'sys',
    addressForms: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

// callOpenAICompatible 解析的 SSE 格式：一个 delta chunk + [DONE] 终止
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
  anthropicCreateMock.mockReset()
  anthropicStreamMock.mockReset()
})

// completeSync 非流式响应格式：一次性 JSON，choices[0].message.content（不是流式的 delta.content）
function fakeNonStreamResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
}

// !response.ok 分支用的失败响应，body 按各测试用例自定（well-formed JSON / 非 JSON / 空 / 超长）
function fakeErrorResponse(status: number, statusText: string, body: string): Response {
  return new Response(body, { status, statusText })
}

async function drain(provider: ReturnType<typeof createModelProviderForPreset>): Promise<void> {
  const context: BuiltContext = { system: '', messages: [{ role: 'user', content: 'hi' }] }
  for await (const _chunk of provider.complete(context)) {
    // 只需要触发 fetch 调用，不关心返回内容
  }
}

describe('createModelProviderForPreset', () => {
  // 这是最容易踩的坑：completeAnthropic/completeOpenAI 读 config.modelName，
  // 但 completeOllama 读的是另一个字段 config.ollamaModel，不看 config.modelName
  it('ollama 类型下 preset.modelName 写入 config.ollamaModel，而不是 config.modelName', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeStreamResponse())
    vi.stubGlobal('fetch', fetchSpy)

    const globalConfig: ModelConfig = { type: 'anthropic', modelName: 'should-not-be-used' }
    const preset = fakePreset({ modelType: 'ollama', modelName: 'llama3' })

    const provider = createModelProviderForPreset(preset, globalConfig)
    await drain(provider)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, options] = fetchSpy.mock.calls[0]
    expect(url).toContain('/v1/chat/completions')
    const body = JSON.parse(options.body)
    expect(body.model).toBe('llama3')
    expect(body.model).not.toBe('should-not-be-used')
  })

  it('非 ollama 类型（openai）下 preset.modelName 写入 config.modelName', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeStreamResponse())
    vi.stubGlobal('fetch', fetchSpy)

    const globalConfig: ModelConfig = { type: 'ollama', ollamaModel: 'should-not-be-used', openaiApiKey: 'key' }
    const preset = fakePreset({ modelType: 'openai', modelName: 'gpt-4o-mini' })

    const provider = createModelProviderForPreset(preset, globalConfig)
    await drain(provider)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [, options] = fetchSpy.mock.calls[0]
    const body = JSON.parse(options.body)
    expect(body.model).toBe('gpt-4o-mini')
    expect(body.model).not.toBe('should-not-be-used')
  })

  // preset.modelType/modelName 为 null 表示该 preset 未自定义对话模型，完全使用
  // globalConfig（不做任何字段覆盖），验证不会被误当成 ollama 分支覆盖 ollamaModel
  it('preset.modelType/modelName 为 null 时，完全使用 globalConfig，不做任何覆盖', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeStreamResponse())
    vi.stubGlobal('fetch', fetchSpy)

    const globalConfig: ModelConfig = { type: 'openai', modelName: 'global-model', openaiApiKey: 'global-key' }
    const preset = fakePreset({ modelType: null, modelName: null })

    const provider = createModelProviderForPreset(preset, globalConfig)
    await drain(provider)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [, options] = fetchSpy.mock.calls[0]
    expect(options.headers.Authorization).toBe('Bearer global-key')
    const body = JSON.parse(options.body)
    expect(body.model).toBe('global-model')
  })

  // openai/deepseek 各自拥有独立的凭据槽位（openaiApiKey/openaiBaseUrl 与
  // deepseekApiKey/deepseekBaseUrl），二者可在同一份 globalConfig 中共存。
  // preset 覆盖 modelType 时必须只取被覆盖类型对应的那组凭据，不能错拿另一组。
  it('globalConfig 同时持有 openai/deepseek 两组凭据时，preset 覆盖为 deepseek 只使用 deepseek 凭据', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeStreamResponse())
    vi.stubGlobal('fetch', fetchSpy)

    const globalConfig: ModelConfig = {
      type: 'openai',
      openaiApiKey: 'sk-openai',
      openaiBaseUrl: 'https://api.openai.com/v1',
      deepseekApiKey: 'sk-deepseek',
      deepseekBaseUrl: 'https://api.deepseek.com',
    }
    const preset = fakePreset({ modelType: 'deepseek', modelName: 'deepseek-v4-pro' })

    const provider = createModelProviderForPreset(preset, globalConfig)
    await drain(provider)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, options] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect(options.headers.Authorization).toBe('Bearer sk-deepseek')
    const body = JSON.parse(options.body)
    expect(body.model).toBe('deepseek-v4-pro')
  })

  it('globalConfig 同时持有 openai/deepseek 两组凭据时，preset 覆盖为 openai 只使用 openai 凭据', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeStreamResponse())
    vi.stubGlobal('fetch', fetchSpy)

    const globalConfig: ModelConfig = {
      type: 'deepseek',
      openaiApiKey: 'sk-openai',
      openaiBaseUrl: 'https://api.openai.com/v1',
      deepseekApiKey: 'sk-deepseek',
      deepseekBaseUrl: 'https://api.deepseek.com',
    }
    const preset = fakePreset({ modelType: 'openai', modelName: 'gpt-4o-mini' })

    const provider = createModelProviderForPreset(preset, globalConfig)
    await drain(provider)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, options] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect(options.headers.Authorization).toBe('Bearer sk-openai')
    const body = JSON.parse(options.body)
    expect(body.model).toBe('gpt-4o-mini')
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
    expect(requestOptions.signal).toBe(signal)
  })

  it('openai 类型下请求体 stream 为 false，解析一次性 JSON 的 choices[0].message.content', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeNonStreamResponse('openai reply'))
    vi.stubGlobal('fetch', fetchSpy)

    const config: ModelConfig = { type: 'openai', modelName: 'gpt-4o-mini', openaiApiKey: 'key' }
    const provider = createModelProvider(config)
    const signal = new AbortController().signal

    const result = await provider.completeSync(context, { signal })

    expect(result).toBe('openai reply')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [, options] = fetchSpy.mock.calls[0]
    const body = JSON.parse(options.body)
    expect(body.stream).toBe(false)
    expect(options.signal).toBe(signal)
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

  it('deepseek 类型下请求体 stream 为 false，打到 deepseekBaseUrl + /chat/completions，带 deepseekApiKey 的 Bearer 头', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeNonStreamResponse('deepseek reply'))
    vi.stubGlobal('fetch', fetchSpy)

    const config: ModelConfig = {
      type: 'deepseek',
      deepseekApiKey: 'sk-deepseek',
      deepseekBaseUrl: 'https://api.deepseek.com',
      modelName: 'deepseek-v4-pro',
    }
    const provider = createModelProvider(config)

    const result = await provider.completeSync(context)

    expect(result).toBe('deepseek reply')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, options] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect(options.headers.Authorization).toBe('Bearer sk-deepseek')
    const body = JSON.parse(options.body)
    expect(body.model).toBe('deepseek-v4-pro')
    expect(body.stream).toBe(false)
  })
})

describe('deepseek 默认值', () => {
  it('未配置 deepseekBaseUrl/modelName 时走默认值 https://api.deepseek.com + deepseek-v4-flash（流式）', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeStreamResponse())
    vi.stubGlobal('fetch', fetchSpy)

    const config: ModelConfig = { type: 'deepseek', deepseekApiKey: 'sk-deepseek' }
    const provider = createModelProvider(config)
    const context: BuiltContext = { system: '', messages: [{ role: 'user', content: 'hi' }] }

    for await (const _chunk of provider.complete(context)) {
      // 只需要触发 fetch 调用，不关心返回内容
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, options] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    const body = JSON.parse(options.body)
    expect(body.model).toBe('deepseek-v4-flash')
  })
})

// provider-capability 落地：response_format: json_object（openai/deepseek/ollama，jsonMode 开关）、
// OpenAI 专属 max_completion_tokens 参数名、DeepSeek 专属 thinking: disabled
// anthropic 分支开发中
describe('provider 专属请求体覆盖（response_format / max_completion_tokens / thinking）', () => {
  const context: BuiltContext = { system: '', messages: [{ role: 'user', content: 'hi' }] }

  it('openai 分支：请求体用 max_completion_tokens，不再是 max_tokens（reasoning 系模型会拒绝后者）', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeStreamResponse())
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createModelProvider({ type: 'openai', modelName: 'gpt-4o-mini', openaiApiKey: 'key' })

    for await (const _chunk of provider.complete(context, { maxTokens: 500 })) {
      // 只需要触发 fetch 调用
    }

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.max_completion_tokens).toBe(500)
    expect(body.max_tokens).toBeUndefined()
  })

  it('openai 分支：jsonMode 未传时请求体不带 response_format（避免误伤不支持 JSON 模式的旧模型/不需要 JSON 输出的调用）', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeStreamResponse())
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createModelProvider({ type: 'openai', modelName: 'gpt-4o-mini', openaiApiKey: 'key' })

    for await (const _chunk of provider.complete(context)) {
      // 只需要触发 fetch 调用
    }

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.response_format).toBeUndefined()
  })

  it('openai 分支：jsonMode 为 true 时请求体带 response_format: json_object', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeStreamResponse())
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createModelProvider({ type: 'openai', modelName: 'gpt-4o-mini', openaiApiKey: 'key' })

    for await (const _chunk of provider.complete(context, { jsonMode: true })) {
      // 只需要触发 fetch 调用
    }

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('deepseek 分支：请求体始终带 thinking: disabled（与 jsonMode 无关，V4 默认开启的推理必须显式关掉），max_tokens 参数名不变', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeStreamResponse())
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createModelProvider({ type: 'deepseek', deepseekApiKey: 'sk-deepseek' })

    for await (const _chunk of provider.complete(context)) {
      // 只需要触发 fetch 调用
    }

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.max_tokens).toBe(1000)
    expect(body.max_completion_tokens).toBeUndefined()
    expect(body.response_format).toBeUndefined()
  })

  it('deepseek 分支：jsonMode 为 true 时额外带 response_format: json_object（thinking 仍然同时存在）', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeStreamResponse())
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createModelProvider({ type: 'deepseek', deepseekApiKey: 'sk-deepseek' })

    for await (const _chunk of provider.complete(context, { jsonMode: true })) {
      // 只需要触发 fetch 调用
    }

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('ollama 分支：不带 thinking（DeepSeek 专属），max_tokens 参数名不变（/v1 兼容层只认这个旧名字），jsonMode 为 true 时带 response_format', async () => {
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
  })

  it('completeSync（非流式）路径同样生效：openai 用 max_completion_tokens，jsonMode 为 true 带 response_format', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeNonStreamResponse('reply'))
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createModelProvider({ type: 'openai', modelName: 'o1', openaiApiKey: 'key' })

    await provider.completeSync(context, { maxTokens: 200, jsonMode: true })

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.max_completion_tokens).toBe(200)
    expect(body.max_tokens).toBeUndefined()
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('completeSync（非流式）路径同样生效：deepseek 始终带 thinking: disabled', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeNonStreamResponse('reply'))
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createModelProvider({ type: 'deepseek', deepseekApiKey: 'sk-deepseek' })

    await provider.completeSync(context)

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.thinking).toEqual({ type: 'disabled' })
  })
})

// resolveMaxTokens 三级 fallback（调用方显式传入 > provider 自身配置的 maxTokens > 1000）：
// summarizer.ts / characterImport.ts / entityExtractor.ts 这三个整理模式调用方不再显式传
// maxTokens，改为完全依赖这条 fallback 链——覆盖点从这三个模块的测试挪到这里
describe('resolveMaxTokens 三级 fallback', () => {
  const context: BuiltContext = { system: '', messages: [{ role: 'user', content: 'hi' }] }

  it('调用方显式传入 maxTokens 时优先生效，即便 provider 自身配置了另一个值', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeNonStreamResponse('reply'))
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createModelProvider({ type: 'openai', modelName: 'gpt-4o-mini', openaiApiKey: 'key', maxTokens: 2000 })

    await provider.completeSync(context, { maxTokens: 500 })

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.max_completion_tokens).toBe(500)
  })

  it('调用方未传 maxTokens 时使用 provider 自身配置的 maxTokens', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeNonStreamResponse('reply'))
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createModelProvider({ type: 'openai', modelName: 'gpt-4o-mini', openaiApiKey: 'key', maxTokens: 2000 })

    await provider.completeSync(context)

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.max_completion_tokens).toBe(2000)
  })

  it('调用方未传 maxTokens 且 provider 自身也未配置时，回落到默认值 1000', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeNonStreamResponse('reply'))
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createModelProvider({ type: 'openai', modelName: 'gpt-4o-mini', openaiApiKey: 'key' })

    await provider.completeSync(context)

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.max_completion_tokens).toBe(1000)
  })
})

// 此前 !response.ok 分支只抛状态行，provider 真正返回的诊断信息被丢弃；这里覆盖 describeErrorResponse
// 读取到的四种 body 形态，以及流式路径同样生效（不只是非流式路径）
describe('失败响应体读取（describeErrorResponse）', () => {
  const context: BuiltContext = { system: '', messages: [{ role: 'user', content: 'hi' }] }

  it('well-formed JSON error 对象：从 error.message 提取诊断信息，而不是只有状态行', async () => {
    const errorBody = JSON.stringify({
      error: { message: 'Invalid model ID: gpt-99', type: 'invalid_request_error', code: 'model_not_found' },
    })
    const fetchSpy = vi.fn().mockResolvedValue(fakeErrorResponse(400, 'Bad Request', errorBody))
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createModelProvider({ type: 'openai', modelName: 'gpt-99', openaiApiKey: 'key' })

    await expect(provider.completeSync(context)).rejects.toThrow(
      'OpenAI API error: 400 Bad Request - Invalid model ID: gpt-99'
    )
  })

  it('非 JSON body：解析失败时原样展示原始文本，而不是丢弃', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      fakeErrorResponse(502, 'Bad Gateway', '<html><body>Bad Gateway</body></html>')
    )
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createModelProvider({ type: 'openai', modelName: 'gpt-4o-mini', openaiApiKey: 'key' })

    await expect(provider.completeSync(context)).rejects.toThrow(
      'OpenAI API error: 502 Bad Gateway - <html><body>Bad Gateway</body></html>'
    )
  })

  it('空 body：退回状态行本身，不拼接多余的 " - "', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeErrorResponse(500, 'Internal Server Error', ''))
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createModelProvider({ type: 'openai', modelName: 'gpt-4o-mini', openaiApiKey: 'key' })

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
    const fetchSpy = vi.fn().mockResolvedValue(
      fakeErrorResponse(400, 'Bad Request', JSON.stringify({ error: { message: longMessage } }))
    )
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createModelProvider({ type: 'openai', modelName: 'gpt-4o-mini', openaiApiKey: 'key' })

    let caught: Error | undefined
    try {
      await provider.completeSync(context)
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeDefined()
    const detail = caught!.message.slice('OpenAI API error: 400 Bad Request - '.length)
    expect(detail.length).toBe(501) // 500 字符 + 1 个省略号
    expect(detail.endsWith('…')).toBe(true)
  })

  it('流式路径（complete）同样读取失败响应体，不只是非流式路径独有', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      fakeErrorResponse(429, 'Too Many Requests', JSON.stringify({ error: { message: 'Rate limit exceeded' } }))
    )
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createModelProvider({ type: 'openai', modelName: 'gpt-4o-mini', openaiApiKey: 'key' })

    await expect(drain(provider)).rejects.toThrow(
      'OpenAI API error: 429 Too Many Requests - Rate limit exceeded'
    )
  })
})

// apiKey 兜底为字面量 'no-key' 会把"用户从未配置凭据"伪装成一次真实请求，最终从 provider 收到
// 不知所云的 401；openai/deepseek 需要真实凭据，提前失败且不发起 fetch；ollama 本地端点不认证，
// 不在此列，必须仍能正常请求
describe('缺失 API Key 时提前失败', () => {
  const context: BuiltContext = { system: '', messages: [{ role: 'user', content: 'hi' }] }

  it('openai 未配置 openaiApiKey 时提前失败，不发起 fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createModelProvider({ type: 'openai', modelName: 'gpt-4o-mini' })

    await expect(provider.completeSync(context)).rejects.toThrow(
      '[ModelProvider] OpenAI API key is not configured'
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('deepseek 未配置 deepseekApiKey 时提前失败，不发起 fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createModelProvider({ type: 'deepseek' })

    await expect(provider.completeSync(context)).rejects.toThrow(
      '[ModelProvider] DeepSeek API key is not configured'
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('ollama 未配置任何凭据字段时仍正常发起请求（本地端点不认证，不应被误判为缺失凭据）', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeNonStreamResponse('ollama reply'))
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createModelProvider({ type: 'ollama' })

    const result = await provider.completeSync(context)

    expect(result).toBe('ollama reply')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
