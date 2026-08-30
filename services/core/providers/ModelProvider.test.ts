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
})
