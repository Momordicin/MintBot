import Anthropic from '@anthropic-ai/sdk'
import type { ChatMessage, ModelConfig, CompletionOptions, BuiltContext, Preset } from '../../../shared/types/index.js'

// callOpenAICompatible(Sync) 对三个 provider 类型（openai/deepseek/ollama）保持无差别的
// 请求体构造，唯二真正因 provider 而异的两处（max_tokens 参数名、额外请求体字段）由
// 各自的 xxxRequestOverrides 静态方法产出，通过这个结构体传入
interface OpenAICompatibleOverrides {
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens'
  extraBody?: Record<string, unknown>
}

export class ModelProvider {
  private config: ModelConfig

  constructor(config: ModelConfig) {
    this.config = config
  }

  // 流式
  async *complete(
    context: BuiltContext,
    options: CompletionOptions = {}
  ): AsyncIterable<string> {
    const messagesWithSystem: ChatMessage[] = context.system
      ? [{ role: 'system' as const, content: context.system }, ...context.messages]
      : context.messages

    switch (this.config.type) {
      case 'anthropic':
        yield* this.completeAnthropic(context.messages, options, context.system)
        break
      case 'openai':
        yield* this.completeOpenAI(messagesWithSystem, options)
        break
      case 'deepseek':
        yield* this.completeDeepSeek(messagesWithSystem, options)
        break
      case 'ollama':
        yield* this.completeOllama(messagesWithSystem, options)
        break
      default:
        throw new Error(`Unknown model provider type: ${this.config.type}`)
    }
  }

  // 非流式
  async completeSync(
    context: BuiltContext,
    options: CompletionOptions = {}
  ): Promise<string> {
    const messagesWithSystem: ChatMessage[] = context.system
      ? [{ role: 'system' as const, content: context.system }, ...context.messages]
      : context.messages

    switch (this.config.type) {
      case 'anthropic':
        return this.completeSyncAnthropic(context.messages, options, context.system)
      case 'openai':
        return this.completeSyncOpenAI(messagesWithSystem, options)
      case 'deepseek':
        return this.completeSyncDeepSeek(messagesWithSystem, options)
      case 'ollama':
        return this.completeSyncOllama(messagesWithSystem, options)
      default:
        throw new Error(`Unknown model provider type: ${this.config.type}`)
    }
  }

  // Anthropic 实现
  // system message 单独放在请求体顶层，不在 messages 数组里

  private async *completeAnthropic(
    messages: ChatMessage[],
    options: CompletionOptions,
    system?: string
  ): AsyncIterable<string> {
    const client = new Anthropic({
      apiKey: this.config.anthropicApiKey,
    })

    const chatMessages = messages.filter(m => m.role !== 'system')

    const stream = await client.messages.stream({
      model: this.config.modelName ?? (() => {
        throw new Error('[ModelProvider] modelName is required in config')
      })(),
      max_tokens: options.maxTokens ?? 1000,
      system: system || undefined,
      messages: chatMessages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    }, { signal: options.signal })

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        yield event.delta.text
      }
    }
  }

  // Anthropic 实现（非流式）

  private async completeSyncAnthropic(
    messages: ChatMessage[],
    options: CompletionOptions,
    system?: string
  ): Promise<string> {
    const client = new Anthropic({
      apiKey: this.config.anthropicApiKey,
    })

    const chatMessages = messages.filter(m => m.role !== 'system')

    const message = await client.messages.create({
      model: this.config.modelName ?? (() => {
        throw new Error('[ModelProvider] modelName is required in config')
      })(),
      max_tokens: options.maxTokens ?? 1000,
      system: system || undefined,
      messages: chatMessages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    }, { signal: options.signal })

    return message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('')
  }

  // OpenAI 实现
  // system message 直接放在 messages 数组第一条

  private async *completeOpenAI(
    messages: ChatMessage[],
    options: CompletionOptions
  ): AsyncIterable<string> {
    yield* ModelProvider.callOpenAICompatible(
      this.config.openaiBaseUrl ?? 'https://api.openai.com/v1',
      this.config.openaiApiKey ?? 'no-key',
      this.config.modelName ?? 'gpt-4o',
      messages,
      options,
      ModelProvider.openAIRequestOverrides(options)
    )
  }

  // DeepSeek 实现（复用 OpenAI 兼容接口，OpenAI 兼容 API）

  private async *completeDeepSeek(
    messages: ChatMessage[],
    options: CompletionOptions
  ): AsyncIterable<string> {
    yield* ModelProvider.callOpenAICompatible(
      this.config.deepseekBaseUrl ?? 'https://api.deepseek.com',
      this.config.deepseekApiKey ?? 'no-key',
      this.config.modelName ?? 'deepseek-v4-flash',
      messages,
      options,
      ModelProvider.deepSeekRequestOverrides(options)
    )
  }

  // Ollama 实现（复用 OpenAI 兼容接口）

  private async *completeOllama(
    messages: ChatMessage[],
    options: CompletionOptions
  ): AsyncIterable<string> {
    yield* ModelProvider.callOpenAICompatible(
      (this.config.ollamaBaseUrl ?? 'http://localhost:11434') + '/v1',
      'ollama',
      this.config.ollamaModel ?? 'qwen3',
      messages,
      options,
      ModelProvider.ollamaRequestOverrides(options)
    )
  }

  // OpenAI 实现（非流式）

  private async completeSyncOpenAI(
    messages: ChatMessage[],
    options: CompletionOptions
  ): Promise<string> {
    return ModelProvider.callOpenAICompatibleSync(
      this.config.openaiBaseUrl ?? 'https://api.openai.com/v1',
      this.config.openaiApiKey ?? 'no-key',
      this.config.modelName ?? 'gpt-4o',
      messages,
      options,
      ModelProvider.openAIRequestOverrides(options)
    )
  }

  // DeepSeek 实现（非流式，复用 OpenAI 兼容接口）

  private async completeSyncDeepSeek(
    messages: ChatMessage[],
    options: CompletionOptions
  ): Promise<string> {
    return ModelProvider.callOpenAICompatibleSync(
      this.config.deepseekBaseUrl ?? 'https://api.deepseek.com',
      this.config.deepseekApiKey ?? 'no-key',
      this.config.modelName ?? 'deepseek-v4-flash',
      messages,
      options,
      ModelProvider.deepSeekRequestOverrides(options)
    )
  }

  // Ollama 实现（非流式，复用 OpenAI 兼容接口）

  private async completeSyncOllama(
    messages: ChatMessage[],
    options: CompletionOptions
  ): Promise<string> {
    return ModelProvider.callOpenAICompatibleSync(
      (this.config.ollamaBaseUrl ?? 'http://localhost:11434') + '/v1',
      'ollama',
      this.config.ollamaModel ?? 'qwen3',
      messages,
      options,
      ModelProvider.ollamaRequestOverrides(options)
    )
  }

  // ─── OpenAI 兼容接口的按 provider 差异化请求覆盖项 ───────────────────
  // callOpenAICompatible(Sync) 本身对三个 provider 类型保持无差别（这正是它存在的意义），
  // 差异全部收在这三个静态方法里，以 { maxTokensParam, extraBody } 的形式传入，
  // 而不是在共用函数内部 if-else 判断 provider 类型——这样共用函数完全不需要知道
  // 调用方是谁，新增/调整某个 provider 的专属参数只需要改对应这一个方法

  // OpenAI：reasoning 系模型（o-series）拒绝 max_tokens，新旧模型都认 max_completion_tokens
  private static openAIRequestOverrides(options: CompletionOptions): OpenAICompatibleOverrides {
    return {
      maxTokensParam: 'max_completion_tokens',
      extraBody: options.jsonMode ? { response_format: { type: 'json_object' } } : undefined,
    }
  }

  // DeepSeek：V4 默认以 "high" effort 开启推理，显式关闭才是真正的轻量调用
  // （用户原话「DeepSeek 用最轻的模型就行」，仅换轻量模型不够，还需要关掉默认开启的推理）；
  // max_tokens 是 DeepSeek 文档唯一记载的参数名，不改
  private static deepSeekRequestOverrides(options: CompletionOptions): OpenAICompatibleOverrides {
    return {
      extraBody: {
        thinking: { type: 'disabled' },
        ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      },
    }
  }

  // Ollama：/v1 兼容层只翻译 max_tokens → num_predict，不认新参数名，不改
  private static ollamaRequestOverrides(options: CompletionOptions): OpenAICompatibleOverrides {
    return {
      extraBody: options.jsonMode ? { response_format: { type: 'json_object' } } : undefined,
    }
  }

  // OpenAI 兼容接口调用

  private static async *callOpenAICompatible(
    baseUrl: string,
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    options: CompletionOptions,
    overrides: OpenAICompatibleOverrides = {}
  ): AsyncIterable<string> {
    const maxTokensParam = overrides.maxTokensParam ?? 'max_tokens'
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        // extraBody 放在最前面展开，让下面这几个共用函数刻意设置的键（model/max_tokens 参数名/
        // stream/messages）始终生效、不被 extraBody 意外覆盖——今天各 provider 的 extraBody
        // （response_format、thinking）都不会撞这几个键名，但这只是现状，不是保证；调换成
        // "共用键在后"是让这一点显式成为不变式，而不是靠"暂时没撞上"侥幸维持
        ...overrides.extraBody,
        model,
        [maxTokensParam]: options.maxTokens ?? 1000,
        stream: true,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      }),
      signal: options.signal,
    })

    if (!response.ok) { throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`) }
    if (!response.body) { throw new Error('[ModelProvider] Response body is null') }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') return

        try {
          const json = JSON.parse(data)
          const chunk = json.choices?.[0]?.delta?.content
          if (chunk) yield chunk
        } catch {
          // 忽略解析失败的行
        }
      }
    }
  }

  // OpenAI 兼容接口调用（非流式）

  private static async callOpenAICompatibleSync(
    baseUrl: string,
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    options: CompletionOptions,
    overrides: OpenAICompatibleOverrides = {}
  ): Promise<string> {
    const maxTokensParam = overrides.maxTokensParam ?? 'max_tokens'
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        // extraBody 放在最前面展开，理由同上面 callOpenAICompatible（流式）那份同款请求体构造
        ...overrides.extraBody,
        model,
        [maxTokensParam]: options.maxTokens ?? 1000,
        stream: false,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      }),
      signal: options.signal,
    })

    if (!response.ok) { throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`) }

    const json = await response.json()
    return json.choices?.[0]?.message?.content ?? ''
  }
}

export function createModelProvider(config: ModelConfig): ModelProvider {
  return new ModelProvider(config)
}

// 按 preset 构建 provider：completeAnthropic/completeOpenAI 读 config.modelName，
// 但 completeOllama 读的是另一个字段 config.ollamaModel，不看 config.modelName——
// 因此不能简单 spread 覆盖 modelName，必须按 modelType 分支写入对应字段。
// preset.modelType/modelName 为 null 表示该 preset 未自定义对话模型，完全使用全局配置
// （含 credentials）——credentials（API key / baseUrl）永远来自全局配置，这点不变，
// 只有"用哪个模型"这一层是可覆盖的
export function createModelProviderForPreset(preset: Preset, globalConfig: ModelConfig): ModelProvider {
  if (preset.modelType === null || preset.modelName === null) {
    return createModelProvider(globalConfig)
  }
  const config: ModelConfig = { ...globalConfig, type: preset.modelType }
  if (preset.modelType === 'ollama') {
    config.ollamaModel = preset.modelName
  } else {
    config.modelName = preset.modelName
  }
  return createModelProvider(config)
}