import Anthropic from '@anthropic-ai/sdk'
import type { ChatMessage, ModelConfig, CompletionOptions, BuiltContext } from '../../../shared/types/index.js'

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
    let result = ''
    for await (const chunk of this.complete(context, options)) {
      result += chunk
    }
    return result
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
    })

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        yield event.delta.text
      }
    }
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
      options
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
      options
    )
  }

  // OpenAI 兼容接口调用

  private static async *callOpenAICompatible(
    baseUrl: string,
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    options: CompletionOptions
  ): AsyncIterable<string> {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: options.maxTokens ?? 1000,
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
}

export function createModelProvider(config: ModelConfig): ModelProvider {
  return new ModelProvider(config)
}