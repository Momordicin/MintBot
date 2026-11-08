// services/core/plugins/toolLoop.test.ts — 工具循环测试：调用一次、步数上限、重复提醒、超时、各类工具出错、空白回复重试、中止
// 用法：pnpm test；插件管理器与模型提供者全部用替身，不连网
// 对应文件：services/core/plugins/toolLoop.ts / services/core/plugins/manager.ts / services/core/providers/ModelProvider.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatTurnRequest, ChatTurnResult, ToolCall } from '../providers/ModelProvider.js'

const { getEnabledToolsMock, createToolContextMock } = vi.hoisted(() => ({
  getEnabledToolsMock: vi.fn(),
  createToolContextMock: vi.fn(),
}))
vi.mock('./manager.js', () => ({
  getEnabledTools: getEnabledToolsMock,
  createToolContext: createToolContextMock,
}))

const { runToolLoop } = await import('./toolLoop.js')

const PARAMETERS = { type: 'object', properties: { period: { type: 'string' } }, required: ['period'] }

function call(id: string, args: Record<string, unknown> = { period: 'today' }, name = 'get_weather'): ToolCall {
  return { id, name, args }
}

function toolTurn(...calls: ToolCall[]): ChatTurnResult {
  return { text: '', toolCalls: calls }
}

function textTurn(text: string): ChatTurnResult {
  return { text, toolCalls: [] }
}

interface Scenario {
  turns: ChatTurnResult[]
  execute?: (args: Record<string, unknown>, ctx: { signal: AbortSignal }) => Promise<unknown>
  callTimeoutMs?: number
  supportsTools?: boolean
  noPlugin?: boolean
  signal?: AbortSignal
}

async function scenario(options: Scenario) {
  const execute = vi.fn(options.execute ?? (async () => '晴'))
  const signals: AbortSignal[] = []
  getEnabledToolsMock.mockReturnValue(options.noPlugin ? [] : [{
    pluginName: 'mintbot_weather',
    displayName: '天气',
    tool: { name: 'get_weather', description: '查天气', parameters: PARAMETERS, execute },
    standard: { call_timeout_ms: options.callTimeoutMs ?? 1000, max_repeat: 3 },
    config: {},
  }])
  createToolContextMock.mockImplementation((_name: string, signal: AbortSignal) => {
    signals.push(signal)
    return { signal }
  })

  const queue = [...options.turns]
  const requests: ChatTurnRequest[] = []
  const chatTurn = vi.fn(async (request: ChatTurnRequest) => {
    requests.push(request)
    const next = queue.shift()
    if (!next) throw new Error('no scripted turn left')
    return next
  })
  const supportsTools = vi.fn(async () => options.supportsTools ?? true)
  const wait = vi.fn(async (_ms: number) => {})

  const run = () => runToolLoop({
    provider: { chatTurn, supportsTools },
    context: { system: 'SYS json', messages: [{ role: 'user', content: 'q' }] },
    maxTokens: 500,
    signal: options.signal ?? new AbortController().signal,
    streaming: false,
    wait,
  })
  return { run, execute, signals, requests, chatTurn, supportsTools, wait }
}

function toolResults(request: ChatTurnRequest): string[] {
  return request.messages.flatMap(message => (message.role === 'tool' ? [message.content] : []))
}

afterEach(() => {
  vi.restoreAllMocks()
  getEnabledToolsMock.mockReset()
  createToolContextMock.mockReset()
})

describe('runToolLoop：工具调用与最终回复', () => {
  it('调用一次工具后得到回复：结果以 tool 消息带入下一步，系统提示末尾加工具规则', async () => {
    const s = await scenario({ turns: [toolTurn(call('c1')), textTurn('final')] })

    expect(await s.run()).toBe('final')

    expect(s.chatTurn).toHaveBeenCalledTimes(2)
    const [first, second] = s.requests
    expect(first.system.startsWith('SYS json')).toBe(true)
    expect(first.system).toContain('<tool_use_instructions>')
    expect(first.tools.map(t => t.name)).toEqual(['get_weather'])
    expect(first.maxTokens).toBe(500)
    expect(first.messages).toEqual([{ role: 'user', content: 'q' }])
    expect(second.messages).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [call('c1')] },
      { role: 'tool', toolCallId: 'c1', content: '晴' },
    ])
    expect(s.execute).toHaveBeenCalledWith({ period: 'today' }, expect.anything())
  })

  it('一步里多个工具调用：一个一个执行，结果按顺序带入', async () => {
    const order: string[] = []
    const s = await scenario({
      turns: [toolTurn(call('c1', { period: 'now' }), call('c2', { period: 'tomorrow' })), textTurn('final')],
      execute: async args => {
        order.push(`start ${args.period}`)
        await new Promise(resolve => setTimeout(resolve, 5))
        order.push(`end ${args.period}`)
        return String(args.period)
      },
    })

    await s.run()

    expect(order).toEqual(['start now', 'end now', 'start tomorrow', 'end tomorrow'])
    expect(toolResults(s.requests[1])).toEqual(['now', 'tomorrow'])
  })

  it('参数里不在参数格式中的字段被丢掉，不传给插件', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = await scenario({ turns: [toolTurn(call('c1', { period: 'today', junk: 1 })), textTurn('final')] })

    await s.run()

    expect(s.execute).toHaveBeenCalledWith({ period: 'today' }, expect.anything())
  })

  it('到了 128 步上限：追加用户消息、收走工具再问一次，这次的回复就是最终回复', async () => {
    const turns = Array.from({ length: 128 }, (_, i) => toolTurn(call(`c${i}`, { period: `p${i}` })))
    const s = await scenario({ turns: [...turns, textTurn('wrap up')] })

    expect(await s.run()).toBe('wrap up')

    expect(s.chatTurn).toHaveBeenCalledTimes(129)
    expect(s.requests[127].tools).toHaveLength(1)
    const last = s.requests[128]
    expect(last.tools).toEqual([])
    expect(last.messages[last.messages.length - 1]).toEqual({ role: 'user', content: expect.stringContaining('已达到插件调用次数上限') })
    expect(s.execute).toHaveBeenCalledTimes(128)
  })

  it('重复调用到 max_repeat 起，在工具结果后附三档提醒，工具不收回', async () => {
    const turns = Array.from({ length: 5 }, (_, i) => toolTurn(call(`c${i}`)))
    const s = await scenario({ turns: [...turns, textTurn('final')] })

    await s.run()

    const results = toolResults(s.requests[5])
    expect(results[0]).toBe('晴')
    expect(results[1]).toBe('晴')
    expect(results[2]).toContain('「天气」已经重复调用了 3 次')
    expect(results[2]).not.toContain('重要')
    expect(results[3]).toContain('「天气」已经重复调用了 4 次')
    expect(results[3]).toContain('重要：')
    expect(results[4]).toContain('「天气」已经重复调用了 5 次')
    expect(results[4]).toContain('重复次数已经很高')
    expect(s.requests.every(request => request.tools.length === 1)).toBe(true)
  })

  it('参数不同或中间调用了别的内容时，重复计数重新开始', async () => {
    const s = await scenario({
      turns: [
        toolTurn(call('c0', { period: 'now' })),
        toolTurn(call('c1', { period: 'today' })),
        toolTurn(call('c2', { period: 'today' })),
        toolTurn(call('c3', { period: 'now' })),
        textTurn('final'),
      ],
    })

    await s.run()

    expect(toolResults(s.requests[4])).toEqual(['晴', '晴', '晴', '晴'])
  })
})

describe('runToolLoop：单个工具的各种结果', () => {
  it.each([
    {
      name: '不存在的工具',
      execute: undefined,
      turn: toolTurn(call('c1', {}, 'nope')),
      expected: 'error: 插件里没有 nope 这个功能，可用的有：get_weather',
      executed: false,
    },
    {
      name: '插件抛错',
      execute: async () => { throw new Error('boom') },
      turn: toolTurn(call('c1')),
      expected: 'error: boom',
      executed: true,
    },
    {
      name: '插件返回空内容',
      execute: async () => '  ',
      turn: toolTurn(call('c1')),
      expected: '插件没有返回内容。',
      executed: true,
    },
  ])('$name', async ({ execute, turn, expected, executed }) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = await scenario({ turns: [turn, textTurn('final')], execute })

    expect(await s.run()).toBe('final')

    expect(toolResults(s.requests[1])).toEqual([expected])
    expect(s.execute).toHaveBeenCalledTimes(executed ? 1 : 0)
  })

  it.each([
    { name: '英文超长', unit: 'a', count: 60000 },
    { name: '中文超长，按字节截断且不留残字', unit: '汉', count: 30000 },
  ])('结果过长：$name', async ({ unit, count }) => {
    const s = await scenario({ turns: [toolTurn(call('c1')), textTurn('final')], execute: async () => unit.repeat(count) })

    await s.run()

    const [result] = toolResults(s.requests[1])
    const notice = '\n（结果过长，已截断）'
    expect(result.endsWith(notice)).toBe(true)
    const body = result.slice(0, result.length - notice.length)
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(50000)
    expect(Buffer.byteLength(body)).toBeGreaterThan(49990)
    expect(body).not.toContain('�')
  })

  it('刚好 50000 字节的结果原样返回', async () => {
    const s = await scenario({ turns: [toolTurn(call('c1')), textTurn('final')], execute: async () => 'a'.repeat(50000) })

    await s.run()

    expect(toolResults(s.requests[1])).toEqual(['a'.repeat(50000)])
  })

  it('超时：到时限立即中止插件并返回 error，不等插件交回文字', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = await scenario({
      turns: [toolTurn(call('c1')), textTurn('final')],
      callTimeoutMs: 30,
      execute: () => new Promise(() => {}),
    })

    expect(await s.run()).toBe('final')

    expect(toolResults(s.requests[1])).toEqual(['error: 插件 天气 调用超时（0.03 秒）'])
    expect(s.signals[0].aborted).toBe(true)
  })

  it('工具调用出错的结果也带重复提醒', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const turns = [toolTurn(call('c0')), toolTurn(call('c1')), toolTurn(call('c2'))]
    const s = await scenario({ turns: [...turns, textTurn('final')], execute: async () => { throw new Error('boom') } })

    await s.run()

    const results = toolResults(s.requests[3])
    expect(results[1]).toBe('error: boom')
    expect(results[2]).toMatch(/^error: boom\n\n\[系统提示\].*「天气」已经重复调用了 3 次/s)
  })
})

describe('runToolLoop：空白回复、没有工具、中止', () => {
  it('最终回复空白时重试，间隔 1、2 秒，拿到文字后返回；工具调用那一轮文字为空不算空白', async () => {
    const s = await scenario({ turns: [toolTurn(call('c1')), textTurn(''), textTurn('  '), textTurn('ok')] })

    expect(await s.run()).toBe('ok')

    expect(s.chatTurn).toHaveBeenCalledTimes(4)
    expect(s.wait.mock.calls.map(args => args[0])).toEqual([1000, 2000])
  })

  it('空白重试 3 次后仍空白：返回空文字，交给聊天接口按失败处理', async () => {
    const s = await scenario({ turns: [textTurn(''), textTurn(''), textTurn(''), textTurn('')] })

    expect(await s.run()).toBe('')

    expect(s.chatTurn).toHaveBeenCalledTimes(4)
    expect(s.wait.mock.calls.map(args => args[0])).toEqual([1000, 2000, 4000])
  })

  it.each([
    { name: '没有已启用的插件', options: { noPlugin: true }, supportsCalls: 0 },
    { name: '模型不支持工具（Ollama 查询结果）', options: { supportsTools: false }, supportsCalls: 1 },
  ])('$name：工具列表为空，系统提示不加工具规则，其余照常', async ({ options, supportsCalls }) => {
    const s = await scenario({ ...options, turns: [textTurn('hi')] })

    expect(await s.run()).toBe('hi')

    expect(s.requests[0].tools).toEqual([])
    expect(s.requests[0].system).toBe('SYS json')
    expect(s.supportsTools).toHaveBeenCalledTimes(supportsCalls)
  })

  it('请求被中止：中止正在运行的插件并停止循环，不再问模型', async () => {
    const controller = new AbortController()
    const s = await scenario({
      turns: [toolTurn(call('c1')), textTurn('never')],
      signal: controller.signal,
      execute: () => new Promise(() => {}),
    })

    const pending = s.run()
    await vi.waitFor(() => expect(s.execute).toHaveBeenCalled())
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(s.signals[0].aborted).toBe(true)
    expect(s.chatTurn).toHaveBeenCalledTimes(1)
  })
})
