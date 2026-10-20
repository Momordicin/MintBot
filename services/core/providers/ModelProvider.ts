// services/core/providers/ModelProvider.ts — 大语言模型调用封装：按配置类型（anthropic / openai / deepseek / ollama）发起流式 complete 或非流式 completeSync
// 用法：routes/models.ts 调 createAnthropicClient / createOpenAIClient 构建 SDK 客户端；routes/chat.ts 每次聊天用 createModelProviderForPreset(preset, 全局配置, 角色凭据)（预设无模型覆盖则用全局配置）调 complete / completeSync；memory/orchestrator.ts 的按角色后台整理用 createSummaryModelProviderForPreset 调 completeSync；index.ts 与 routes/config.ts 用 createModelProvider 构建 fastify.modelProvider / backgroundModelProvider，后者的 completeSync 供 orchestrator 驱动 entityExtractor 与 summarizer
// 对应文件：services/core/routes/chat.ts / services/core/routes/config.ts / services/core/routes/models.ts / services/core/index.ts / services/core/memory/orchestrator.ts / shared/types/index.ts / services/core/providers/envCredentials.ts / services/core/session/queries.ts / services/core/providers/ModelProvider.test.ts
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { ChatCompletionCreateParamsBase } from 'openai/resources/chat/completions'
import type { ChatMessage, ModelConfig, CompletionOptions, BuiltContext, Preset } from '../../../shared/types/index.js'
import { getEnvCredential, type KeyProvider } from './envCredentials.js'
import type { PresetCredentials } from '../session/queries.js'

const STREAM_TIMEOUT_MS = 30000
const OLLAMA_TIMEOUT_MS = 120000

type DeepSeekExtras = { thinking: { type: 'disabled' } }

const KEY_FIELD: Record<KeyProvider, { key: 'anthropicApiKey' | 'openaiApiKey' | 'deepseekApiKey'; fromEnv: 'anthropicApiKeyFromEnv' | 'openaiApiKeyFromEnv' | 'deepseekApiKeyFromEnv'; label: string }> = {
  anthropic: { key: 'anthropicApiKey', fromEnv: 'anthropicApiKeyFromEnv', label: 'Anthropic' },
  openai: { key: 'openaiApiKey', fromEnv: 'openaiApiKeyFromEnv', label: 'OpenAI' },
  deepseek: { key: 'deepseekApiKey', fromEnv: 'deepseekApiKeyFromEnv', label: 'DeepSeek' },
}

export function resolveApiKey(
  config: ModelConfig,
  provider: KeyProvider,
  readEnvKey: (provider: KeyProvider) => string = getEnvCredential
): string {
  const { key, fromEnv, label } = KEY_FIELD[provider]
  if (config[fromEnv] === true) {
    const envKey = readEnvKey(provider)
    if (!envKey) {
      throw new Error(`[ModelProvider] ${label} API key environment variable is not available`)
    }
    return envKey
  }
  const saved = config[key]
  if (!saved) {
    throw new Error(`[ModelProvider] ${label} API key is not configured`)
  }
  return saved
}

export function createAnthropicClient(config: ModelConfig): Anthropic {
  const key = resolveApiKey(config, 'anthropic')
  return new Anthropic({
    apiKey: key,
    authToken: null,
    baseURL: 'https://api.anthropic.com',
    logLevel: 'warn',
    webhookKey: null,
    maxRetries: 2,
  })
}

export function createOpenAIClient(config: ModelConfig, kind: 'openai' | 'deepseek'): OpenAI {
  const key = kind === 'openai'
    ? resolveApiKey(config, 'openai')
    : resolveApiKey(config, 'deepseek')
  const baseURL = kind === 'openai'
    ? (config.openaiBaseUrl || 'https://api.openai.com/v1')
    : (config.deepseekBaseUrl || 'https://api.deepseek.com')
  return new OpenAI({
    apiKey: key,
    adminAPIKey: null,
    organization: null,
    project: null,
    baseURL,
    webhookSecret: null,
    logLevel: 'warn',
    maxRetries: 2,
  })
}

interface OpenAICompatibleOverrides {
  extraBody?: Record<string, unknown>
}

function ollamaSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(OLLAMA_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

class ThinkTagFilter {
  private inThink = false
  private pending = ''

  push(text: string): string {
    let data = this.pending + text
    this.pending = ''
    let out = ''
    while (data) {
      const tag = this.inThink ? '</think>' : '<think>'
      const index = data.indexOf(tag)
      if (index >= 0) {
        if (!this.inThink) out += data.slice(0, index)
        data = data.slice(index + tag.length)
        this.inThink = !this.inThink
        continue
      }
      let keep = Math.min(tag.length - 1, data.length)
      while (keep > 0 && !data.endsWith(tag.slice(0, keep))) keep--
      const safe = data.length - keep
      if (!this.inThink) out += data.slice(0, safe)
      this.pending = data.slice(safe)
      break
    }
    return out
  }

  flush(): string {
    const rest = this.inThink ? '' : this.pending
    this.pending = ''
    return rest
  }
}

export function stripThinkTags(text: string): string {
  let rest = text
  let out = ''
  while (true) {
    const open = rest.indexOf('<think>')
    const close = rest.indexOf('</think>')
    if (close >= 0 && (open < 0 || close < open)) {
      out = ''
      rest = rest.slice(close + '</think>'.length)
      continue
    }
    if (open < 0) return (out + rest).trim()
    out += rest.slice(0, open)
    const end = rest.indexOf('</think>', open + '<think>'.length)
    if (end < 0) return out.trim()
    rest = rest.slice(end + '</think>'.length)
  }
}

function mapOllamaTimeout(err: unknown, callerSignal?: AbortSignal): unknown {
  if (err instanceof Error && err.name === 'TimeoutError' && !callerSignal?.aborted) {
    return new Error(`Ollama call timed out after ${OLLAMA_TIMEOUT_MS / 1000}s`, { cause: err })
  }
  return err
}

export class ModelProvider {
  private config: ModelConfig

  constructor(config: ModelConfig) {
    this.config = config
  }

  get providerType(): ModelConfig['type'] {
    return this.config.type
  }

  private resolveMaxTokens(options: CompletionOptions): number {
    return options.maxTokens ?? this.config.maxTokens ?? 1000
  }

  private createAnthropicClient(): Anthropic {
    return createAnthropicClient(this.config)
  }

  private createOpenAIClient(kind: 'openai' | 'deepseek'): OpenAI {
    return createOpenAIClient(this.config, kind)
  }

  private buildOpenAIBody(
    kind: 'openai' | 'deepseek',
    messages: ChatMessage[],
    options: CompletionOptions
  ): ChatCompletionCreateParamsBase | (ChatCompletionCreateParamsBase & DeepSeekExtras) {
    const mapped = messages.map(m => ({ role: m.role, content: m.content }))
    const maxTokens = this.resolveMaxTokens(options)
    const responseFormat = options.jsonMode ? { response_format: { type: 'json_object' as const } } : {}
    if (kind === 'openai') {
      return {
        model: this.config.modelName ?? 'gpt-4o',
        max_completion_tokens: maxTokens,
        messages: mapped,
        ...responseFormat,
      }
    }
    return {
      model: this.config.modelName ?? 'deepseek-v4-flash',
      max_tokens: maxTokens,
      messages: mapped,
      thinking: { type: 'disabled' as const },
    }
  }

  private async *streamOpenAI(
    kind: 'openai' | 'deepseek',
    messages: ChatMessage[],
    options: CompletionOptions
  ): AsyncIterable<string> {
    const client = this.createOpenAIClient(kind)
    const stream = await client.chat.completions.create(
      { ...this.buildOpenAIBody(kind, messages, options), stream: true },
      { signal: options.signal, timeout: STREAM_TIMEOUT_MS }
    )
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content
      if (text) yield text
    }
  }

  private async createOpenAISync(
    kind: 'openai' | 'deepseek',
    messages: ChatMessage[],
    options: CompletionOptions
  ): Promise<string> {
    const client = this.createOpenAIClient(kind)
    const completion = await client.chat.completions.create(
      { ...this.buildOpenAIBody(kind, messages, options), stream: false },
      { signal: options.signal }
    )
    return completion.choices[0]?.message?.content ?? ''
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
    const client = this.createAnthropicClient()

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
    }, { signal: options.signal, timeout: STREAM_TIMEOUT_MS })

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
    const client = this.createAnthropicClient()

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
    yield* this.streamOpenAI('openai', messages, options)
  }

  private async *completeDeepSeek(
    messages: ChatMessage[],
    options: CompletionOptions
  ): AsyncIterable<string> {
    yield* this.streamOpenAI('deepseek', messages, options)
  }

  private async *completeOllama(
    messages: ChatMessage[],
    options: CompletionOptions
  ): AsyncIterable<string> {
    try {
      yield* ModelProvider.callOpenAICompatible(
        (this.config.ollamaBaseUrl || 'http://localhost:11434') + '/v1',
        'ollama',
        this.config.ollamaModel ?? 'qwen3',
        messages,
        options,
        ModelProvider.ollamaRequestOverrides(options)
      )
    } catch (err) {
      throw mapOllamaTimeout(err, options.signal)
    }
  }

  private async completeSyncOpenAI(
    messages: ChatMessage[],
    options: CompletionOptions
  ): Promise<string> {
    return this.createOpenAISync('openai', messages, options)
  }

  private async completeSyncDeepSeek(
    messages: ChatMessage[],
    options: CompletionOptions
  ): Promise<string> {
    return this.createOpenAISync('deepseek', messages, options)
  }

  private async completeSyncOllama(
    messages: ChatMessage[],
    options: CompletionOptions
  ): Promise<string> {
    try {
      return await ModelProvider.callOpenAICompatibleSync(
        (this.config.ollamaBaseUrl || 'http://localhost:11434') + '/v1',
        'ollama',
        this.config.ollamaModel ?? 'qwen3',
        messages,
        options,
        ModelProvider.ollamaRequestOverrides(options)
      )
    } catch (err) {
      throw mapOllamaTimeout(err, options.signal)
    }
  }

  private static ollamaRequestOverrides(options: CompletionOptions): OpenAICompatibleOverrides {
    return {
      extraBody: options.jsonMode ? { response_format: { type: 'json_object' } } : {},
    }
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
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        ...overrides.extraBody,
        model,
        stream: true,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      }),
      signal: ollamaSignal(options.signal),
    })

    if (!response.ok) { throw new Error(`OpenAI API error: ${await ModelProvider.describeErrorResponse(response)}`) }
    if (!response.body) { throw new Error('[ModelProvider] Response body is null') }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const filter = new ThinkTagFilter()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        const rest = filter.flush()
        if (rest) yield rest
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') {
          const rest = filter.flush()
          if (rest) yield rest
          return
        }

        let text: string | undefined
        try {
          text = filter.push(JSON.parse(data).choices?.[0]?.delta?.content ?? '')
        } catch {
        }
        if (text) yield text
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
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        ...overrides.extraBody,
        model,
        stream: false,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      }),
      signal: ollamaSignal(options.signal),
    })

    if (!response.ok) { throw new Error(`OpenAI API error: ${await ModelProvider.describeErrorResponse(response)}`) }

    const json = await response.json()
    return stripThinkTags(json.choices?.[0]?.message?.content ?? '')
  }
}

export function createModelProvider(config: ModelConfig): ModelProvider {
  return new ModelProvider(config)
}

export function createModelProviderForPreset(
  preset: Preset,
  globalConfig: ModelConfig,
  credentials: PresetCredentials
): ModelProvider {
  if (preset.modelType === null || preset.modelName === null) {
    return createModelProvider(globalConfig)
  }
  const config: ModelConfig = { ...globalConfig, type: preset.modelType }
  if (preset.modelType === 'ollama') {
    config.ollamaModel = preset.modelName
  } else {
    config.modelName = preset.modelName
    const { key, fromEnv } = KEY_FIELD[preset.modelType]
    const role = credentials[preset.modelType]
    config[key] = role?.apiKey
    config[fromEnv] = role?.fromEnv === true
  }
  return createModelProvider(config)
}

export function createSummaryModelProviderForPreset(
  preset: Preset,
  globalConfig: ModelConfig,
  credentials: PresetCredentials
): ModelProvider {
  if (preset.modelType === null || preset.summaryModelType === null || preset.summaryModelName === null) {
    return createModelProviderForPreset(preset, globalConfig, credentials)
  }
  const config: ModelConfig = { ...globalConfig, type: preset.summaryModelType }
  if (preset.summaryModelType === 'ollama') {
    config.ollamaModel = preset.summaryModelName
  } else {
    config.modelName = preset.summaryModelName
    const { key, fromEnv } = KEY_FIELD[preset.summaryModelType]
    const role = credentials[preset.summaryModelType]
    config[key] = role?.summaryApiKey
    config[fromEnv] = role?.summaryFromEnv === true
  }
  return createModelProvider(config)
}
