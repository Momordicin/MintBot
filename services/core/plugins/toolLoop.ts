// services/core/plugins/toolLoop.ts — 一轮聊天的工具循环：取已启用插件的工具、逐步问模型、执行工具调用，返回最终回复文字
// 用法：routes/chat.ts 调 runToolLoop({ provider, context, maxTokens, signal, streaming })，请求的 system 依次为 context.system、工具使用规则（有工具时）、context.outputRules；通过 manager.ts 的 getEnabledTools / createToolContext 取工具并执行，通过 ModelProvider 的 supportsTools / chatTurn 问模型
// 对应文件：services/core/routes/chat.ts / services/core/plugins/manager.ts / services/core/providers/ModelProvider.ts / services/core/plugins/toolLoop.test.ts
import type { BuiltContext } from '../../../shared/types/index.js'
import type { ModelProvider, ToolCall, ToolSpec, TurnMessage } from '../providers/ModelProvider.js'
import { createToolContext, getEnabledTools, type EnabledTool } from './manager.js'

const MAX_STEPS = 128
const MAX_RESULT_BYTES = 50_000
const EMPTY_REPLY_WAITS_MS = [1000, 2000, 4000]

const TOOL_RULES =
  '\n\n<tool_use_instructions>\n使用插件工具时：不要返回空白回复；开始一类新事情时简短说明目的，不必每次调用前都说；严格按参数格式调用，不要编造参数；保持原来的说话风格，回复仍按要求在末尾写标签。\n</tool_use_instructions>'

const LIMIT_PROMPT =
  '[系统提示] 已达到插件调用次数上限。不要再调用插件，直接根据已有结果回答用户，并说明还没完成的部分。'

export interface ToolLoopParams {
  provider: Pick<ModelProvider, 'chatTurn' | 'supportsTools'>
  context: BuiltContext
  maxTokens?: number
  signal: AbortSignal
  streaming: boolean
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
}

type Outcome =
  | { kind: 'done'; value: unknown }
  | { kind: 'error'; err: unknown }
  | { kind: 'timeout' }
  | { kind: 'aborted' }

function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done)
  })
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function truncateResult(text: string): string {
  const bytes = Buffer.from(text, 'utf-8')
  if (bytes.length <= MAX_RESULT_BYTES) return text
  const cut = bytes.subarray(0, MAX_RESULT_BYTES).toString('utf-8').replace(/�+$/, '')
  return `${cut}\n（结果过长，已截断）`
}

function repeatNotice(entry: EnabledTool, streak: number): string {
  const max = entry.standard.max_repeat
  if (streak < max) return ''
  const plugin = entry.displayName
  const subject = `你已经用相同的参数连续调用「${plugin}」的 ${entry.tool.name} ${streak} 次了。`
  const tell = `请在回复里告诉用户「${plugin}」已经重复调用了 ${streak} 次。`
  const level = Math.min(streak - max, 2)
  if (level === 0) return `\n\n[系统提示] ${subject}请想想换个参数、换个做法，或者直接总结目前的结果是否更有帮助。${tell}`
  if (level === 1) return `\n\n[系统提示] 重要：${subject}除非确实有必要，否则不要再重复同样的操作，请换个做法，或者总结还缺少什么。${tell}`
  return `\n\n[系统提示] 重要：${subject}重复次数已经很高。只有每次调用都能得到新信息时才继续，否则请换个做法、调整参数，或者向用户说明做不到的原因。${tell}`
}

async function executeTool(entry: EnabledTool, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const timeoutMs = entry.standard.call_timeout_ms
  const controller = new AbortController()
  let onAbort = () => {}
  const aborted = new Promise<Outcome>(resolve => {
    onAbort = () => {
      controller.abort()
      resolve({ kind: 'aborted' })
    }
  })
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Outcome>(resolve => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ kind: 'timeout' })
    }, timeoutMs)
  })

  let outcome: Outcome
  try {
    const ctx = createToolContext(entry.pluginName, controller.signal)
    const done = entry.tool.execute(args, ctx).then((value): Outcome => ({ kind: 'done', value }))
    done.catch(() => undefined)
    outcome = await Promise.race([done, timeout, aborted])
  } catch (err) {
    outcome = { kind: 'error', err }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
  signal.throwIfAborted()

  if (outcome.kind === 'timeout') {
    console.error(`[Plugins] ${entry.pluginName}: tool ${entry.tool.name} timed out after ${timeoutMs}ms`)
    return `error: 插件 ${entry.displayName} 调用超时（${timeoutMs / 1000} 秒）`
  }
  if (outcome.kind === 'error') {
    console.error(`[Plugins] ${entry.pluginName}: tool ${entry.tool.name} failed:`, outcome.err)
    return `error: ${outcome.err instanceof Error ? outcome.err.message : String(outcome.err)}`
  }
  if (outcome.kind === 'done' && typeof outcome.value === 'string' && outcome.value.trim() !== '') {
    return truncateResult(outcome.value)
  }
  return '插件没有返回内容。'
}

export async function runToolLoop(params: ToolLoopParams): Promise<string> {
  const { provider, context, maxTokens, signal, streaming } = params
  const wait = params.wait ?? defaultWait

  let enabled = getEnabledTools()
  if (enabled.length > 0 && !(await provider.supportsTools())) enabled = []
  const specs: ToolSpec[] = enabled.map(({ tool }) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
  const system = `${context.system}${specs.length > 0 ? TOOL_RULES : ''}${context.outputRules ? `\n\n${context.outputRules}` : ''}`
  const messages: TurnMessage[] = context.messages.map(message => ({ ...message }))

  const ask = async (tools: ToolSpec[]) => {
    for (let retry = 0; ; retry++) {
      signal.throwIfAborted()
      const turn = await provider.chatTurn({ system, messages: [...messages], tools, maxTokens, signal, stream: streaming })
      if (turn.toolCalls.length > 0 || turn.text.trim() !== '' || retry >= EMPTY_REPLY_WAITS_MS.length) return turn
      await wait(EMPTY_REPLY_WAITS_MS[retry], signal)
    }
  }

  let lastKey = ''
  let streak = 0
  const runCall = async (call: ToolCall): Promise<string> => {
    const entry = enabled.find(item => item.tool.name === call.name)
    let args = call.args
    if (entry) {
      const properties = (entry.tool.parameters as { properties?: Record<string, unknown> }).properties
      const expected = new Set(Object.keys(properties ?? {}))
      const ignored = Object.keys(call.args).filter(key => !expected.has(key))
      if (ignored.length > 0) {
        console.error(`[Plugins] ${entry.pluginName}: tool ${call.name} ignored parameters not in the schema: ${ignored.join(', ')}`)
      }
      args = Object.fromEntries(Object.entries(call.args).filter(([key]) => expected.has(key)))
    }
    const key = `${call.name}\n${stableJson(args)}`
    streak = key === lastKey ? streak + 1 : 1
    lastKey = key
    if (!entry) {
      return `error: 插件里没有 ${call.name} 这个功能，可用的有：${enabled.map(item => item.tool.name).join('、')}`
    }
    return (await executeTool(entry, args, signal)) + repeatNotice(entry, streak)
  }

  for (let step = 0; step < MAX_STEPS; step++) {
    const turn = await ask(specs)
    if (turn.toolCalls.length === 0) return turn.text
    messages.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls })
    for (const call of turn.toolCalls) {
      messages.push({ role: 'tool', toolCallId: call.id, content: await runCall(call) })
    }
  }

  messages.push({ role: 'user', content: LIMIT_PROMPT })
  return (await ask([])).text
}
