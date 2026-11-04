import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { claudeLoginMock, claudeSearchMock, codexLoginMock, codexSearchMock } = vi.hoisted(() => ({
  claudeLoginMock: vi.fn(),
  claudeSearchMock: vi.fn(),
  codexLoginMock: vi.fn(),
  codexSearchMock: vi.fn(),
}))
vi.mock('../agents/claudeCode.js', () => ({
  getClaudeLoginStatus: claudeLoginMock,
  claudeWebSearch: claudeSearchMock,
}))
vi.mock('../agents/codex.js', () => ({
  getCodexLoginStatus: codexLoginMock,
  codexWebSearch: codexSearchMock,
}))

const { runWebLookup, WEB_LOOKUP_SCHEMA } = await import('./webLookup.js')
const { formatLocalTime } = await import('./subscriptionSearch.js')

const NOT_LOGGED_IN = '未登录：请告知用户先在设置的全局模型服务中登录 Claude Code 或 Codex'

beforeEach(() => {
  claudeLoginMock.mockReset().mockResolvedValue(true)
  claudeSearchMock.mockReset().mockResolvedValue({ text: '上海今天晴，22 度' })
  codexLoginMock.mockReset().mockResolvedValue(true)
  codexSearchMock.mockReset().mockResolvedValue({ text: 'codex 结论' })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function stubTimeout(): AbortController {
  const timeoutController = new AbortController()
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal)
  return timeoutController
}

describe('web_lookup 工具定义', () => {
  it('名称与参数 schema', () => {
    expect(WEB_LOOKUP_SCHEMA.name).toBe('web_lookup')
    expect(WEB_LOOKUP_SCHEMA.parameters).toMatchObject({ required: ['query'] })
    expect(WEB_LOOKUP_SCHEMA.description).toContain('不要调用本工具，先用你自己的口吻问用户在哪个城市')
  })
})

describe('runWebLookup', () => {
  it('Claude 已登录时只走 Claude，只返回结论文本，不记录日志', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await runWebLookup({ query: '上海今天天气' }, new AbortController().signal)

    expect(result).toBe('以下是查询到的资料，只作参考：\n上海今天晴，22 度\n请用你自己的口吻和说话方式，把用户关心的部分告诉用户，不要照抄原文。')
    expect(claudeSearchMock).toHaveBeenCalledTimes(1)
    expect(codexLoginMock).not.toHaveBeenCalled()
    expect(codexSearchMock).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('Claude 未登录而 Codex 已登录时改用 Codex', async () => {
    claudeLoginMock.mockResolvedValue(false)

    const result = await runWebLookup({ query: '上海今天天气' }, new AbortController().signal)

    expect(result).toBe('以下是查询到的资料，只作参考：\ncodex 结论\n请用你自己的口吻和说话方式，把用户关心的部分告诉用户，不要照抄原文。')
    expect(claudeSearchMock).not.toHaveBeenCalled()
    expect(codexSearchMock).toHaveBeenCalledTimes(1)
  })

  it('两者都未登录时返回登录提示，不发起查询，也不记错误日志', async () => {
    claudeLoginMock.mockResolvedValue(false)
    codexLoginMock.mockResolvedValue(false)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await runWebLookup({ query: '上海今天天气' }, new AbortController().signal)

    expect(result).toBe(NOT_LOGGED_IN)
    expect(claudeSearchMock).not.toHaveBeenCalled()
    expect(codexSearchMock).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('传给订阅的提示词是固定格式，包含查询、本地日期时间和时区', async () => {
    vi.setSystemTime(new Date('2026-11-03T06:20:00Z'))

    await runWebLookup({ query: '上海今天天气' }, new AbortController().signal)

    const prompt: string = claudeSearchMock.mock.calls[0][0].query
    expect(prompt).toBe(`请联网查询，用中文分点列出查询到的事实要点和相关建议，每条一行；不要寒暄，不要写成段落，不要列出查询过程：\n上海今天天气\n当前本地时间：${formatLocalTime(new Date('2026-11-03T06:20:00Z'))}`)
    expect(prompt).toMatch(/当前本地时间：2026-11-0\d 星期[日一二三四五六] \d{2}:\d{2}（UTC[+-]\d+(:\d{2})?）$/)
  })

  it('请求的取消信号会传到子进程的信号，取消后不记错误日志', async () => {
    const chat = new AbortController()
    let childSignal: AbortSignal | undefined
    claudeSearchMock.mockImplementation((params: { signal: AbortSignal }) => {
      childSignal = params.signal
      return new Promise((_resolve, reject) => {
        params.signal.addEventListener('abort', () => reject(params.signal.reason))
      })
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const pending = runWebLookup({ query: '上海今天天气' }, chat.signal)
    await vi.waitFor(() => expect(childSignal).toBeDefined())
    expect(childSignal!.aborted).toBe(false)
    chat.abort()

    await pending
    expect(childSignal!.aborted).toBe(true)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('整次查询使用 180000ms 超时信号；超时后返回"查询未能完成"并把查询与错误写入错误日志', async () => {
    const timeout = stubTimeout()
    const timeoutSpy = AbortSignal.timeout as unknown as ReturnType<typeof vi.fn>
    claudeSearchMock.mockImplementation((params: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        params.signal.addEventListener('abort', () => reject(params.signal.reason))
      })
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const pending = runWebLookup({ query: '上海今天天气' }, new AbortController().signal)
    await vi.waitFor(() => expect(claudeSearchMock).toHaveBeenCalled())
    timeout.abort(new DOMException('timed out', 'TimeoutError'))

    expect(await pending).toBe('查询未能完成')
    expect(timeoutSpy).toHaveBeenCalledWith(180000)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0].map(String).join(' ')).toContain('上海今天天气')
  })

  it('登录检查本身卡住时同样受 3 分钟限制', async () => {
    const timeout = stubTimeout()
    claudeLoginMock.mockReturnValue(new Promise(() => {}))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const pending = runWebLookup({ query: '上海今天天气' }, new AbortController().signal)
    await vi.waitFor(() => expect(claudeLoginMock).toHaveBeenCalled())
    timeout.abort(new DOMException('timed out', 'TimeoutError'))

    expect(await pending).toBe('查询未能完成')
    expect(claudeSearchMock).not.toHaveBeenCalled()
  })

  it('查询失败时返回"查询未能完成"并记录日志', async () => {
    claudeSearchMock.mockRejectedValue(new Error('Claude Code 调用失败'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await runWebLookup({ query: '上海今天天气' }, new AbortController().signal)).toBe('查询未能完成')
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('查询结果为空时按失败处理', async () => {
    claudeSearchMock.mockResolvedValue({ text: '  ' })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await runWebLookup({ query: '上海今天天气' }, new AbortController().signal)).toBe('查询未能完成')
  })

  it('缺少 query 参数时不发起查询', async () => {
    expect(await runWebLookup({}, new AbortController().signal)).toBe('参数无效：需要 query')
    expect(claudeLoginMock).not.toHaveBeenCalled()
  })
})
