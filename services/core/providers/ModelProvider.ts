import Anthropic from '@anthropic-ai/sdk'
import type { ChatMessage, ModelConfig, CompletionOptions, BuiltContext, Preset } from '../../../shared/types/index.js'

interface OpenAICompatibleOverrides {
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens'
  extraBody?: Record<string, unknown>
}

export class ModelProvider {
  private config: ModelConfig

  constructor(config: ModelConfig) {
    this.config = config
  }

  private resolveMaxTokens(options: CompletionOptions): number {
    return options.maxTokens ?? this.config.maxTokens ?? 1000
  }

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
      max_tokens: this.resolveMaxTokens(options),
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
      max_tokens: this.resolveMaxTokens(options),
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

  private async *completeOpenAI(
    messages: ChatMessage[],
    options: CompletionOptions
  ): AsyncIterable<string> {
    yield* ModelProvider.callOpenAICompatible(
      this.config.openaiBaseUrl ?? 'https://api.openai.com/v1',
      ModelProvider.requireApiKey(this.config.openaiApiKey, 'OpenAI'),
      this.config.modelName ?? 'gpt-4o',
      messages,
      { ...options, maxTokens: this.resolveMaxTokens(options) },
      ModelProvider.openAIRequestOverrides(options)
    )
  }

  private async *completeDeepSeek(
    messages: ChatMessage[],
    options: CompletionOptions
  ): AsyncIterable<string> {
    yield* ModelProvider.callOpenAICompatible(
      this.config.deepseekBaseUrl ?? 'https://api.deepseek.com',
      ModelProvider.requireApiKey(this.config.deepseekApiKey, 'DeepSeek'),
      this.config.modelName ?? 'deepseek-v4-flash',
      messages,
      { ...options, maxTokens: this.resolveMaxTokens(options) },
      ModelProvider.deepSeekRequestOverrides(options)
    )
  }

  private async *completeOllama(
    messages: ChatMessage[],
    options: CompletionOptions
  ): AsyncIterable<string> {
    yield* ModelProvider.callOpenAICompatible(
      (this.config.ollamaBaseUrl ?? 'http://localhost:11434') + '/v1',
      'ollama',
      this.config.ollamaModel ?? 'qwen3',
      messages,
      { ...options, maxTokens: this.resolveMaxTokens(options) },
      ModelProvider.ollamaRequestOverrides(options)
    )
  }

  private async completeSyncOpenAI(
    messages: ChatMessage[],
    options: CompletionOptions
  ): Promise<string> {
    return ModelProvider.callOpenAICompatibleSync(
      this.config.openaiBaseUrl ?? 'https://api.openai.com/v1',
      ModelProvider.requireApiKey(this.config.openaiApiKey, 'OpenAI'),
      this.config.modelName ?? 'gpt-4o',
      messages,
      { ...options, maxTokens: this.resolveMaxTokens(options) },
      ModelProvider.openAIRequestOverrides(options)
    )
  }

  private async completeSyncDeepSeek(
    messages: ChatMessage[],
    options: CompletionOptions
  ): Promise<string> {
    return ModelProvider.callOpenAICompatibleSync(
      this.config.deepseekBaseUrl ?? 'https://api.deepseek.com',
      ModelProvider.requireApiKey(this.config.deepseekApiKey, 'DeepSeek'),
      this.config.modelName ?? 'deepseek-v4-flash',
      messages,
      { ...options, maxTokens: this.resolveMaxTokens(options) },
      ModelProvider.deepSeekRequestOverrides(options)
    )
  }

  private async completeSyncOllama(
    messages: ChatMessage[],
    options: CompletionOptions
  ): Promise<string> {
    return ModelProvider.callOpenAICompatibleSync(
      (this.config.ollamaBaseUrl ?? 'http://localhost:11434') + '/v1',
      'ollama',
      this.config.ollamaModel ?? 'qwen3',
      messages,
      { ...options, maxTokens: this.resolveMaxTokens(options) },
      ModelProvider.ollamaRequestOverrides(options)
    )
  }

  private static openAIRequestOverrides(options: CompletionOptions): OpenAICompatibleOverrides {
    return {
      maxTokensParam: 'max_completion_tokens',
      extraBody: options.jsonMode ? { response_format: { type: 'json_object' } } : undefined,
    }
  }

  private static deepSeekRequestOverrides(options: CompletionOptions): OpenAICompatibleOverrides {
    return {
      extraBody: {
        thinking: { type: 'disabled' },
        ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      },
    }
  }

  private static ollamaRequestOverrides(options: CompletionOptions): OpenAICompatibleOverrides {
    return {
      extraBody: options.jsonMode ? { response_format: { type: 'json_object' } } : undefined,
    }
  }

  private static requireApiKey(apiKey: string | undefined, providerLabel: string): string {
    if (!apiKey) {
      throw new Error(`[ModelProvider] ${providerLabel} API key is not configured`)
    }
    return apiKey
  }

  private static async describeErrorResponse(response: Response): Promise<string> {
    const statusLine = `${response.status} ${response.statusText}`
    let text: string
    try {
      text = await response.text()
    } catch {
      return statusLine
    }
    if (!text) return statusLine

    const detail = ModelProvider.extractErrorDetail(text)
    const bounded = detail.length > 500 ? `${detail.slice(0, 500)}…` : detail
    return `${statusLine} - ${bounded}`
  }

  private static extractErrorDetail(text: string): string {
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } }
      const message = parsed?.error?.message
      if (typeof message === 'string' && message) return message
    } catch {
    }
    return text
  }

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

    if (!response.ok) { throw new Error(`OpenAI API error: ${await ModelProvider.describeErrorResponse(response)}`) }
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
        }
      }
    }
  }

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

    if (!response.ok) { throw new Error(`OpenAI API error: ${await ModelProvider.describeErrorResponse(response)}`) }

    const json = await response.json()
    return json.choices?.[0]?.message?.content ?? ''
  }
}

export function createModelProvider(config: ModelConfig): ModelProvider {
  return new ModelProvider(config)
}

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