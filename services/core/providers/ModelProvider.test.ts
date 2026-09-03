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
    displayConfig: { chatBgRgb: [15, 15, 20], chatBgOpacity: 0.65 },
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

    const globalConfig: ModelConfig = { type: 'ollama', ollamaModel: 'should-not-be-used' }
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
