// services/core/providers/ModelProvider.ts — 大语言模型调用封装：按配置类型（anthropic / openai / deepseek / ollama）发起流式 complete、非流式 completeSync，以及带工具的单步聊天 chatTurn
// 用法：routes/models.ts 调 createAnthropicClient / createOpenAIClient 构建 SDK 客户端；routes/chat.ts 每次聊天用 createModelProviderForPreset(preset, 全局配置, 角色凭据)（预设无模型覆盖则用全局配置）交给 plugins/toolLoop.ts，后者调 supportsTools / chatTurn；memory/orchestrator.ts 的按角色后台整理用 createSummaryModelProviderForPreset 调 completeSync；index.ts 与 routes/config.ts 用 createModelProvider 构建 fastify.modelProvider / backgroundModelProvider，后者的 completeSync 供 orchestrator 驱动 entityExtractor 与 summarizer
// 对应文件：services/core/routes/chat.ts / services/core/routes/config.ts / services/core/routes/models.ts / services/core/index.ts / services/core/memory/orchestrator.ts / shared/types/index.ts / services/core/providers/envCredentials.ts / services/core/session/queries.ts / services/core/plugins/toolLoop.ts / services/core/providers/ollama.ts / services/core/providers/ModelProvider.test.ts
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { ChatCompletionCreateParamsBase, ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions'
import type { ChatMessage, ModelConfig, CompletionOptions, BuiltContext, Preset } from '../../../shared/types/index.js'
import { getEnvCredential, type KeyProvider } from './envCredentials.js'
import { ollamaSupportsTools } from './ollama.js'
import type { PresetCredentials } from '../session/queries.js'

const STREAM_TIMEOUT_MS = 30000
const OLLAMA_FIRST_OUTPUT_TIMEOUT_MS = 120000
const OLLAMA_STALL_TIMEOUT_MS = 60000
const OLLAMA_SYNC_TIMEOUT_MS = 300000

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
  const timeout = AbortSignal.timeout(OLLAMA_SYNC_TIMEOUT_MS)
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
    return new Error(`Ollama call timed out after ${OLLAMA_SYNC_TIMEOUT_MS / 1000}s`, { cause: err })
  }
  return err
}

export interface ToolSpec {
  name: string
  description: string
  parameters: object
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export type TurnMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string }

export interface ChatTurnRequest {
  system: string
  messages: TurnMessage[]
  tools: ToolSpec[]
  maxTokens?: number
  signal?: AbortSignal
  stream: boolean
}

export interface ChatTurnResult {
  text: string
  toolCalls: ToolCall[]
}

interface ToolCallDelta {
  index?: number
  id?: string | null
  function?: { name?: string | null; arguments?: string | null }
}

function parseToolArgs(raw: unknown): Record<string, unknown> {
  let value = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return {}
    try {
      value = JSON.parse(raw)
    } catch (err) {
      console.error(`[ModelProvider] 解析工具参数失败: ${err instanceof Error ? err.message : String(err)}; 原文: ${raw.slice(0, 200)}`)
      return {}
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

class ToolCallAssembler {
  private calls = new Map<number, { id: string; name: string; args: string }>()

  push(deltas: ToolCallDelta[] | null | undefined): void {
    deltas?.forEach((delta, position) => {
      const index = delta.index ?? position
      const call = this.calls.get(index) ?? { id: '', name: '', args: '' }
      if (delta.id) call.id = delta.id
      if (delta.function?.name) call.name = delta.function.name
      if (delta.function?.arguments) call.args += delta.function.arguments
      this.calls.set(index, call)
    })
  }

  result(): ToolCall[] {
    return [...this.calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, call]) => call.name !== '')
      .map(([index, call]) => ({ id: call.id || `call_${index}`, name: call.name, args: parseToolArgs(call.args) }))
  }
}

function openAIToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return []
  const calls: ToolCall[] = []
  raw.forEach((item, index) => {
    const call = item as { id?: string; type?: string; function?: { name?: string; arguments?: unknown } } | null
    if (!call?.function?.name || (call.type !== undefined && call.type !== 'function')) return
    calls.push({ id: call.id || `call_${index}`, name: call.function.name, args: parseToolArgs(call.function.arguments) })
  })
  return calls
}

function toOpenAIMessages(system: string, messages: TurnMessage[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = system ? [{ role: 'system', content: system }] : []
  for (const message of messages) {
    if (message.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content })
    } else if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      out.push({
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map(call => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      })
    } else {
      out.push({ role: message.role, content: message.content })
    }
  }
  return out
}

function toOpenAITools(tools: ToolSpec[]): ChatCompletionTool[] {
  return tools.map(tool => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters as Record<string, unknown> },
  }))
}

function toAnthropicMessages(messages: TurnMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []
  const lastToolResults = (): Anthropic.ContentBlockParam[] | null => {
    const last = out[out.length - 1]
    return last?.role === 'user' && Array.isArray(last.content) ? last.content : null
  }
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'tool') {
      const block: Anthropic.ToolResultBlockParam = { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }
      const open = lastToolResults()
      if (open) open.push(block)
      else out.push({ role: 'user', content: [block] })
    } else if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      const blocks: Anthropic.ContentBlockParam[] = []
      if (message.content) blocks.push({ type: 'text', text: message.content })
      for (const call of message.toolCalls) blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args })
      out.push({ role: 'assistant', content: blocks })
    } else {
      const open = message.role === 'user' ? lastToolResults() : null
      if (open) open.push({ type: 'text', text: message.content })
      else out.push({ role: message.role, content: message.content })
    }
  }
  return out
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

  async supportsTools(): Promise<boolean> {
    if (this.config.type !== 'ollama') return true
    return ollamaSupportsTools(this.config.ollamaBaseUrl || 'http://localhost:11434', this.config.ollamaModel ?? 'qwen3')
  }

  async chatTurn(request: ChatTurnRequest): Promise<ChatTurnResult> {
    switch (this.config.type) {
      case 'anthropic':
        return this.chatTurnAnthropic(request)
      case 'openai':
        return this.chatTurnOpenAI('openai', request)
      case 'deepseek':
        return this.chatTurnOpenAI('deepseek', request)
      case 'ollama':
        try {
          return await ModelProvider.callOpenAICompatibleTurn(
            (this.config.ollamaBaseUrl || 'http://localhost:11434') + '/v1',
            'ollama',
            this.config.ollamaModel ?? 'qwen3',
            request
          )
        } catch (err) {
          throw mapOllamaTimeout(err, request.signal)
        }
      default:
        throw new Error(`Unknown model provider type: ${this.config.type}`)
    }
  }

  private buildOpenAITurnBody(
    kind: 'openai' | 'deepseek',
    request: ChatTurnRequest
  ): ChatCompletionCreateParamsBase | (ChatCompletionCreateParamsBase & DeepSeekExtras) {
    const maxTokens = request.maxTokens ?? this.config.maxTokens ?? 1000
    const messages = toOpenAIMessages(request.system, request.messages)
    const hasTools = request.tools.length > 0
    const tools = hasTools ? { tools: toOpenAITools(request.tools) } : {}
    if (kind === 'openai') {
      return {
        model: this.config.modelName ?? 'gpt-4o',
        max_completion_tokens: maxTokens,
        messages,
        ...tools,
      }
    }
    return {
      model: this.config.modelName ?? 'deepseek-v4-flash',
      max_tokens: maxTokens,
      messages,
      thinking: { type: 'disabled' as const },
      ...tools,
    }
  }

  private async chatTurnOpenAI(kind: 'openai' | 'deepseek', request: ChatTurnRequest): Promise<ChatTurnResult> {
    const client = this.createOpenAIClient(kind)
    const body = this.buildOpenAITurnBody(kind, request)
    if (!request.stream) {
      const completion = await client.chat.completions.create(
        { ...body, stream: false },
        { signal: request.signal }
      )
      const message = completion.choices[0]?.message
      return { text: message?.content ?? '', toolCalls: openAIToolCalls(message?.tool_calls) }
    }
    const stream = await client.chat.completions.create(
      { ...body, stream: true },
      { signal: request.signal, timeout: STREAM_TIMEOUT_MS }
    )
    let text = ''
    const assembler = new ToolCallAssembler()
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta
      if (delta?.content) text += delta.content
      assembler.push(delta?.tool_calls)
    }
    return { text, toolCalls: assembler.result() }
  }

  private async chatTurnAnthropic(request: ChatTurnRequest): Promise<ChatTurnResult> {
    const client = this.createAnthropicClient()
    const params = {
      model: this.config.modelName ?? (() => {
        throw new Error('[ModelProvider] modelName is required in config')
      })(),
      max_tokens: request.maxTokens ?? this.config.maxTokens ?? 1000,
      system: request.system || undefined,
      messages: toAnthropicMessages(request.messages),
      tools: request.tools.length > 0
        ? request.tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters as Anthropic.Tool.InputSchema,
          }))
        : undefined,
    }
    if (!request.stream) {
      const message = await client.messages.create(params, { signal: request.signal })
      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map(block => block.text)
        .join('')
      const toolCalls = message.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
        .map(block => ({ id: block.id, name: block.name, args: parseToolArgs(block.input) }))
      return { text, toolCalls }
    }
    const stream = await client.messages.stream(params, { signal: request.signal, timeout: STREAM_TIMEOUT_MS })
    let text = ''
    const pending = new Map<number, { id: string; name: string; json: string }>()
    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        pending.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: '' })
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') text += event.delta.text
        else if (event.delta.type === 'input_json_delta') {
          const call = pending.get(event.index)
          if (call) call.json += event.delta.partial_json
        }
      }
    }
    const toolCalls = [...pending.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => ({ id: call.id, name: call.name, args: parseToolArgs(call.json) }))
    return { text, toolCalls }
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
    const controller = new AbortController()
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    let timeoutError: Error | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = (ms: number, message: string) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        timeoutError = new Error(message)
        controller.abort()
      }, ms)
    }
    arm(OLLAMA_FIRST_OUTPUT_TIMEOUT_MS, `Ollama produced no output within ${OLLAMA_FIRST_OUTPUT_TIMEOUT_MS / 1000}s`)

    try {
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
        signal,
      })

      if (!response.ok) { throw new Error(`OpenAI API error: ${await ModelProvider.describeErrorResponse(response)}`) }
      if (!response.body) { throw new Error('[ModelProvider] Response body is null') }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const filter = new ThinkTagFilter()
      let buffer = ''
      let received = false

      while (true) {
        if (received) arm(OLLAMA_STALL_TIMEOUT_MS, `Ollama stream stalled for ${OLLAMA_STALL_TIMEOUT_MS / 1000}s`)
        const { done, value } = await reader.read()
        clearTimeout(timer)
        received = true
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
    } catch (err) {
      if (timeoutError && !options.signal?.aborted) throw timeoutError
      throw err
    } finally {
      clearTimeout(timer)
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

  private static async callOpenAICompatibleTurn(
    baseUrl: string,
    apiKey: string,
    model: string,
    request: ChatTurnRequest
  ): Promise<ChatTurnResult> {
    const hasTools = request.tools.length > 0
    const body = JSON.stringify({
      model,
      stream: request.stream,
      messages: toOpenAIMessages(request.system, request.messages),
      ...(hasTools ? { tools: toOpenAITools(request.tools) } : {}),
    })
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    }

    if (!request.stream) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body,
        signal: ollamaSignal(request.signal),
      })
      if (!response.ok) { throw new Error(`OpenAI API error: ${await ModelProvider.describeErrorResponse(response)}`) }
      const json = await response.json()
      const message = json.choices?.[0]?.message
      return { text: stripThinkTags(message?.content ?? ''), toolCalls: openAIToolCalls(message?.tool_calls) }
    }

    const controller = new AbortController()
    const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal
    let timeoutError: Error | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = (ms: number, message: string) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        timeoutError = new Error(message)
        controller.abort()
      }, ms)
    }
    arm(OLLAMA_FIRST_OUTPUT_TIMEOUT_MS, `Ollama produced no output within ${OLLAMA_FIRST_OUTPUT_TIMEOUT_MS / 1000}s`)

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body, signal })
      if (!response.ok) { throw new Error(`OpenAI API error: ${await ModelProvider.describeErrorResponse(response)}`) }
      if (!response.body) { throw new Error('[ModelProvider] Response body is null') }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const filter = new ThinkTagFilter()
      const assembler = new ToolCallAssembler()
      let text = ''
      let buffer = ''
      let received = false
      const finish = (): ChatTurnResult => {
        text += filter.flush()
        return { text, toolCalls: assembler.result() }
      }

      while (true) {
        if (received) arm(OLLAMA_STALL_TIMEOUT_MS, `Ollama stream stalled for ${OLLAMA_STALL_TIMEOUT_MS / 1000}s`)
        const { done, value } = await reader.read()
        clearTimeout(timer)
        received = true
        if (done) return finish()

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') return finish()
          try {
            const delta = JSON.parse(data).choices?.[0]?.delta
            text += filter.push(delta?.content ?? '')
            assembler.push(delta?.tool_calls)
          } catch {
          }
        }
      }
    } catch (err) {
      if (timeoutError && !request.signal?.aborted) throw timeoutError
      throw err
    } finally {
      clearTimeout(timer)
    }
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
