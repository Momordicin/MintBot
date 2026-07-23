import { describe, it, expect, vi, afterEach } from 'vitest'
import { createModelProviderForPreset } from './ModelProvider.js'
import type { Preset, ModelConfig, BuiltContext } from '../../../shared/types/index.js'

function fakePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    presetId: 'p1',
    name: 'test',
    characterId: 'c1',
    modelType: 'ollama',
    modelName: 'llama3',
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
})

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
