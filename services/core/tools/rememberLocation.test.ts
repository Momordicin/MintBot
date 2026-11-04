import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'

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

const { runRememberLocation, REMEMBER_LOCATION_SCHEMA } = await import('./rememberLocation.js')
const { USER_PROFILE_PATH, getLocation, setLocation } = await import('../profile/userProfile.js')

beforeEach(() => {
  fs.rmSync(USER_PROFILE_PATH, { force: true })
  claudeLoginMock.mockReset().mockResolvedValue(true)
  claudeSearchMock.mockReset().mockResolvedValue({ text: '中国上海市徐汇区' })
  codexLoginMock.mockReset().mockResolvedValue(true)
  codexSearchMock.mockReset().mockResolvedValue({ text: '中国北京市海淀区' })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('remember_location 工具定义', () => {
  it('名称与参数 schema', () => {
    expect(REMEMBER_LOCATION_SCHEMA.name).toBe('remember_location')
    expect(REMEMBER_LOCATION_SCHEMA.parameters).toMatchObject({ required: ['place'] })
    expect(REMEMBER_LOCATION_SCHEMA.description).toBe('用户告诉你所在城市或地区，或者说搬家了时调用，传入用户的原话。')
  })
})

describe('runRememberLocation', () => {
  it('Claude 补全成功后写入用户资料，并返回完整名称', async () => {
    const result = await runRememberLocation({ place: '徐汇' }, new AbortController().signal)

    expect(result).toBe('已记下所在地：中国上海市徐汇区')
    expect(claudeSearchMock.mock.calls[0][0].query).toBe('把地点"徐汇"补全为完整的标准名称，格式为"国家 + 省/州 + 市（+ 区县）"，只输出名称本身。')
    expect(getLocation()).toMatchObject({ value: '中国上海市徐汇区', userInput: '徐汇' })
  })

  it('Claude 未登录时用 Codex 补全', async () => {
    claudeLoginMock.mockResolvedValue(false)

    const result = await runRememberLocation({ place: '海淀' }, new AbortController().signal)

    expect(result).toBe('已记下所在地：中国北京市海淀区')
    expect(getLocation()?.value).toBe('中国北京市海淀区')
  })

  it('两者都未登录时不写入，结果说明需要登录', async () => {
    claudeLoginMock.mockResolvedValue(false)
    codexLoginMock.mockResolvedValue(false)

    const result = await runRememberLocation({ place: '徐汇' }, new AbortController().signal)

    expect(result).toBe('未登录：请告知用户先在设置的全局模型服务中登录 Claude Code 或 Codex')
    expect(getLocation()).toBeNull()
  })

  it('补全失败时不写入，已有的所在地保持不变，并记录日志', async () => {
    setLocation({ value: '中国上海市', userInput: '上海' })
    claudeSearchMock.mockRejectedValue(new Error('Claude Code 调用失败'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await runRememberLocation({ place: '海淀' }, new AbortController().signal)

    expect(result).toBe('未能记下所在地：查询未能完成')
    expect(getLocation()?.value).toBe('中国上海市')
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('3 分钟超时后不写入', async () => {
    const timeoutController = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal)
    claudeSearchMock.mockImplementation((params: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        params.signal.addEventListener('abort', () => reject(params.signal.reason))
      })
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const pending = runRememberLocation({ place: '徐汇' }, new AbortController().signal)
    await vi.waitFor(() => expect(claudeSearchMock).toHaveBeenCalled())
    timeoutController.abort(new DOMException('timed out', 'TimeoutError'))

    expect(await pending).toBe('未能记下所在地：查询未能完成')
    expect(AbortSignal.timeout).toHaveBeenCalledWith(180000)
    expect(getLocation()).toBeNull()
  })

  it('请求取消后不写入', async () => {
    const chat = new AbortController()
    claudeSearchMock.mockImplementation((params: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        params.signal.addEventListener('abort', () => reject(params.signal.reason))
      })
    )

    const pending = runRememberLocation({ place: '徐汇' }, chat.signal)
    await vi.waitFor(() => expect(claudeSearchMock).toHaveBeenCalled())
    chat.abort()
    await pending

    expect(getLocation()).toBeNull()
  })

  it('补全完成时请求已取消，不写入', async () => {
    const chat = new AbortController()
    claudeSearchMock.mockImplementation(async () => {
      chat.abort()
      return { text: '中国上海市徐汇区' }
    })

    const result = await runRememberLocation({ place: '徐汇' }, chat.signal)

    expect(result).toBe('未能记下所在地：对话已取消')
    expect(getLocation()).toBeNull()
  })

  it('缺少 place 参数时不发起查询', async () => {
    expect(await runRememberLocation({}, new AbortController().signal)).toBe('参数无效：需要 place')
    expect(claudeLoginMock).not.toHaveBeenCalled()
  })
})
