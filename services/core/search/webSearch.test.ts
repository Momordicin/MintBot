// services/core/search/webSearch.test.ts — 联网搜索服务测试：三家请求格式与结果对应、两个订阅、错误种类、超时或连不上时的切换、中止
// 用法：pnpm test；联网封装与两个订阅函数全部用 mock，不连网、不启动命令行
// 对应文件：services/core/search/webSearch.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FetchResult } from '../plugins/pluginFetch.js'

const { fetchMock, claudeMock, codexMock, getWebSearchConfigMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  claudeMock: vi.fn(),
  codexMock: vi.fn(),
  getWebSearchConfigMock: vi.fn(),
}))

vi.mock('../plugins/pluginFetch.js', () => ({ createPluginFetch: () => fetchMock }))
vi.mock('../agents/claudeCode.js', () => ({ claudeWebSearch: claudeMock }))
vi.mock('../agents/codex.js', () => ({ codexWebSearch: codexMock }))
vi.mock('../config/index.js', () => ({ getWebSearchConfig: getWebSearchConfigMock }))

const { webSearch, testWebSearchKey, WebSearchError } = await import('./webSearch.js')

type Order = ('deepseek' | 'tavily' | 'anysearch' | 'claude' | 'codex')[]

const BASE_CONFIG = { order: [] as Order, anysearchZone: null }
const JSON_HEADERS = { 'Content-Type': 'application/json' }

function ok(body: unknown): FetchResult {
  return { ok: true, status: 200, body: JSON.stringify(body) }
}

function configure(overrides: Record<string, unknown>) {
  getWebSearchConfigMock.mockReturnValue({ ...BASE_CONFIG, ...overrides })
}

async function failure(promise: Promise<unknown>) {
  return promise.then(
    () => { throw new Error('expected webSearch to reject') },
    (err: unknown) => err as InstanceType<typeof WebSearchError>
  )
}

const signal = () => new AbortController().signal

beforeEach(() => {
  fetchMock.mockReset()
  claudeMock.mockReset()
  codexMock.mockReset()
  getWebSearchConfigMock.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('三家接口的请求格式与结果对应', () => {
  const cases: [string, Order, Record<string, unknown>, number | undefined, string, Record<string, string>, Record<string, unknown>, unknown, Record<string, unknown>][] = [
    ['DeepSeek 带条数', ['deepseek'], { deepseekApiKey: 'ds-key' }, 5, 'https://api.deepseek.com/v1/tools/search',
      { ...JSON_HEADERS, Authorization: 'Bearer ds-key' }, { query: 'q', count: 5 },
      { results: [{ title: 'T', url: 'https://a', snippet: 'S', summary: 'M', date: '2026-01-02' }] },
      { provider: 'deepseek', results: [{ title: 'T', url: 'https://a', snippet: 'S', summary: 'M', publishedAt: '2026-01-02' }] }],
    ['DeepSeek 不给条数就不传', ['deepseek'], { deepseekApiKey: 'ds-key' }, undefined, 'https://api.deepseek.com/v1/tools/search',
      { ...JSON_HEADERS, Authorization: 'Bearer ds-key' }, { query: 'q' },
      { results: [{ title: 'T', url: 'https://a', snippet: 'S' }] },
      { provider: 'deepseek', results: [{ title: 'T', url: 'https://a', snippet: 'S' }] }],
    ['Tavily', ['tavily'], { tavilyApiKey: 'tv-key' }, 3, 'https://api.tavily.com/search',
      { ...JSON_HEADERS, Authorization: 'Bearer tv-key' }, { query: 'q', max_results: 3 },
      { results: [{ title: 'T', url: 'https://a', content: 'C', score: 0.9 }] },
      { provider: 'tavily', results: [{ title: 'T', url: 'https://a', snippet: 'C' }] }],
    ['AnySearch 不填 Key、不限制地区', ['anysearch'], {}, undefined, 'https://api.anysearch.com/v1/search',
      JSON_HEADERS, { query: 'q' },
      { data: { results: [{ title: '', url: 'https://a' }] } },
      { provider: 'anysearch', results: [{ title: '', url: 'https://a', snippet: '' }] }],
    ['AnySearch 带 Key、地区 cn', ['anysearch'], { anysearchApiKey: 'any-key', anysearchZone: 'cn' }, 2, 'https://api.anysearch.com/v1/search',
      { ...JSON_HEADERS, Authorization: 'Bearer any-key' }, { query: 'q', max_results: 2, zone: 'cn' },
      { data: { results: [{ title: 'T', url: 'https://a', snippet: 'S' }] } },
      { provider: 'anysearch', results: [{ title: 'T', url: 'https://a', snippet: 'S' }] }],
  ]

  it.each(cases)('%s', async (_name, order, config, count, url, headers, body, response, expected) => {
    configure({ order, ...config })
    fetchMock.mockResolvedValue(ok(response))
    const abort = signal()

    const result = await webSearch({ query: 'q', count, signal: abort })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(url, { method: 'POST', headers, body: JSON.stringify(body) }, abort)
    expect(result).toEqual({ query: 'q', ...expected })
  })
})

describe('Claude Code、Codex 订阅', () => {
  it.each([
    ['claude', claudeMock],
    ['codex', codexMock],
  ] as const)('%s：text 作为 answer，results 为空，不传条数', async (provider, mock) => {
    configure({ order: [provider] })
    mock.mockResolvedValue({ text: '订阅答案' })

    const result = await webSearch({ query: 'q', count: 5, signal: signal() })

    expect(result).toEqual({ provider, query: 'q', results: [], answer: '订阅答案' })
    expect(mock).toHaveBeenCalledWith({ query: 'q', signal: expect.any(AbortSignal) })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('订阅提示词', () => {
  it.each([
    ['claude', claudeMock],
    ['codex', codexMock],
  ] as const)('%s：传了 subscriptionPrompt 时订阅收到它，网页接口仍收到 query', async (provider, mock) => {
    configure({ order: [provider] })
    mock.mockResolvedValue({ text: 'a' })
    await webSearch({ query: 'q', subscriptionPrompt: '提示词', signal: signal() })
    expect(mock).toHaveBeenCalledWith({ query: '提示词', signal: expect.any(AbortSignal) })

    configure({ order: ['tavily'], tavilyApiKey: 'k' })
    fetchMock.mockResolvedValue(ok({ results: [] }))
    await webSearch({ query: 'q', subscriptionPrompt: '提示词', signal: signal() })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ query: 'q' })
  })
})

describe('不发请求就报错', () => {
  const cases: [string, Order, string, number | undefined][] = [
    ['DeepSeek 搜索词超过 128 字', ['deepseek'], '字'.repeat(129), undefined],
    ['DeepSeek 条数为 0', ['deepseek'], 'q', 0],
    ['DeepSeek 条数超过 50', ['deepseek'], 'q', 51],
    ['Tavily 条数超过 20', ['tavily'], 'q', 21],
    ['AnySearch 条数超过 10', ['anysearch'], 'q', 11],
    ['条数不是整数', ['tavily'], 'q', 1.5],
  ]

  it.each(cases)('%s → invalid_query', async (_name, order, query, count) => {
    configure({ order, deepseekApiKey: 'k', tavilyApiKey: 'k' })

    const error = await failure(webSearch({ query, count, signal: signal() }))

    expect(error).toBeInstanceOf(WebSearchError)
    expect(error.kind).toBe('invalid_query')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('搜索词为空、顺序为空：不换下一家（中止见下）', () => {
  it('搜索词为空 → invalid_query，不发请求', async () => {
    configure({ order: ['deepseek', 'tavily'], deepseekApiKey: 'k', tavilyApiKey: 'k' })

    const error = await failure(webSearch({ query: '  ', signal: signal() }))

    expect(error.kind).toBe('invalid_query')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('顺序列表为空 → not_configured', async () => {
    configure({ order: [] })

    const error = await failure(webSearch({ query: 'q', signal: signal() }))

    expect(error.kind).toBe('not_configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('失败时换下一家', () => {
  const cases: [string, FetchResult][] = [
    ['401', { ok: false, kind: 'http', status: 401, message: 'bad key' }],
    ['不是 JSON', { ok: true, status: 200, body: '<html>' }],
    ['缺少结果数组', ok({ other: 1 })],
    ['某条缺少字符串 url', ok({ results: [{ title: 'x', url: 5 }] })],
  ]

  it.each(cases)('DeepSeek %s → 换 Tavily，provider 为 tavily', async (_name, response) => {
    configure({ order: ['deepseek', 'tavily'], deepseekApiKey: 'k', tavilyApiKey: 'k' })
    fetchMock.mockResolvedValueOnce(response).mockResolvedValueOnce(ok({ results: [] }))

    const result = await webSearch({ query: 'q', signal: signal() })

    expect(result.provider).toBe('tavily')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('DeepSeek 搜索词超过 128 字 → 不发请求，换 Tavily', async () => {
    configure({ order: ['deepseek', 'tavily'], deepseekApiKey: 'k', tavilyApiKey: 'k' })
    fetchMock.mockResolvedValue(ok({ results: [] }))

    const result = await webSearch({ query: '字'.repeat(129), signal: signal() })

    expect(result.provider).toBe('tavily')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('第一家调用时没有 Key → 换下一家', async () => {
    configure({ order: ['deepseek', 'tavily'], tavilyApiKey: 'k' })
    fetchMock.mockResolvedValue(ok({ results: [] }))

    const result = await webSearch({ query: 'q', signal: signal() })

    expect(result.provider).toBe('tavily')
  })

  it('联网封装抛出意外异常 → 当作这一家失败，换下一家', async () => {
    configure({ order: ['deepseek', 'tavily'], deepseekApiKey: 'k', tavilyApiKey: 'k' })
    fetchMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(ok({ results: [] }))

    const result = await webSearch({ query: 'q', signal: signal() })

    expect(result.provider).toBe('tavily')
  })

  it('0 条结果算成功', async () => {
    configure({ order: ['tavily'], tavilyApiKey: 'k' })
    fetchMock.mockResolvedValue(ok({ results: [] }))

    expect(await webSearch({ query: 'q', signal: signal() })).toEqual({ provider: 'tavily', query: 'q', results: [] })
  })

  it('全部超时或连不上 → 报错，message 含每家原因', async () => {
    configure({ order: ['deepseek', 'tavily'], deepseekApiKey: 'k', tavilyApiKey: 'k' })
    fetchMock
      .mockResolvedValueOnce({ ok: false, kind: 'timeout', message: '超过 10000 毫秒' })
      .mockResolvedValueOnce({ ok: false, kind: 'connect', message: 'ECONNREFUSED' })

    const error = await failure(webSearch({ query: 'q', signal: signal() }))

    expect(error.kind).toBe('connect')
    expect(error.message).toContain('DeepSeek 搜索：请求超时')
    expect(error.message).toContain('Tavily：无法连接')
  })

  it('最后一家是其他错误 → kind 取最后一家的，message 仍含第一家原因', async () => {
    configure({ order: ['deepseek', 'tavily'], deepseekApiKey: 'k', tavilyApiKey: 'k' })
    fetchMock
      .mockResolvedValueOnce({ ok: false, kind: 'timeout', message: '超过 10000 毫秒' })
      .mockResolvedValueOnce({ ok: false, kind: 'http', status: 401, message: 'bad key' })

    const error = await failure(webSearch({ query: 'q', signal: signal() }))

    expect(error.kind).toBe('http')
    expect(error.message).toContain('DeepSeek 搜索：请求超时')
    expect(error.message).toContain('HTTP 401')
  })

  it('订阅函数抛错 → 换下一家，provider 为下一家；全部失败时 message 带各家前缀', async () => {
    configure({ order: ['claude', 'tavily'], tavilyApiKey: 'k' })
    claudeMock.mockRejectedValue(new Error('Claude Code 调用失败，请确认订阅已登录且额度可用'))
    fetchMock.mockResolvedValueOnce(ok({ results: [] })).mockResolvedValueOnce({ ok: false, kind: 'timeout', message: '超过 10000 毫秒' })

    const result = await webSearch({ query: 'q', signal: signal() })
    expect(result.provider).toBe('tavily')

    const error = await failure(webSearch({ query: 'q', signal: signal() }))
    expect(error.message).toContain('Claude Code 订阅：Claude Code 调用失败，请确认订阅已登录且额度可用')
    expect(error.message).toContain('Tavily：请求超时')
  })

  it('订阅调用到 60 秒时限 → 按超时换下一家', async () => {
    vi.useFakeTimers()
    configure({ order: ['claude', 'tavily'], tavilyApiKey: 'k' })
    claudeMock.mockImplementation(({ signal: callSignal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      callSignal.addEventListener('abort', () => reject(new Error('Claude Code 调用已取消')))
    }))
    fetchMock.mockResolvedValue(ok({ results: [] }))

    const pending = webSearch({ query: 'q', signal: signal() })
    await vi.advanceTimersByTimeAsync(59999)
    expect(fetchMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    const result = await pending

    expect(result.provider).toBe('tavily')
  })
})

describe('中止', () => {
  it('调用前已中止 → aborted，不发请求', async () => {
    configure({ order: ['deepseek', 'tavily'], deepseekApiKey: 'k', tavilyApiKey: 'k' })
    const controller = new AbortController()
    controller.abort()

    const error = await failure(webSearch({ query: 'q', signal: controller.signal }))

    expect(error.kind).toBe('aborted')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('联网封装返回 aborted → aborted，不切换', async () => {
    configure({ order: ['deepseek', 'tavily'], deepseekApiKey: 'k', tavilyApiKey: 'k' })
    fetchMock.mockResolvedValue({ ok: false, kind: 'aborted', message: '调用已中止' })

    const error = await failure(webSearch({ query: 'q', signal: signal() }))

    expect(error.kind).toBe('aborted')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('订阅调用中途中止 → aborted，不切换', async () => {
    configure({ order: ['codex', 'tavily'], tavilyApiKey: 'k' })
    codexMock.mockImplementation(({ signal: callSignal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      callSignal.addEventListener('abort', () => reject(new Error('Codex 调用已取消')))
    }))
    const controller = new AbortController()

    const pending = failure(webSearch({ query: 'q', signal: controller.signal }))
    controller.abort()
    const error = await pending

    expect(error.kind).toBe('aborted')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('testWebSearchKey', () => {
  const cases: [string, 'deepseek' | 'tavily', string, string][] = [
    ['DeepSeek', 'deepseek', 'https://api.deepseek.com/models', 'ds-key'],
    ['Tavily', 'tavily', 'https://api.tavily.com/usage', 'tv-key'],
  ]

  it.each(cases)('%s：GET 对应地址，带 Bearer Key', async (_name, provider, url, key) => {
    configure({ deepseekApiKey: 'ds-key', tavilyApiKey: 'tv-key' })
    fetchMock.mockResolvedValue(ok({}))
    const abort = signal()

    await testWebSearchKey(provider, abort)

    expect(fetchMock).toHaveBeenCalledWith(url, { method: 'GET', headers: { Authorization: `Bearer ${key}` } }, abort)
  })

  it.each(['deepseek', 'tavily'] as const)('%s 没有 Key → not_configured，不发请求', async provider => {
    configure({})

    const error = await failure(testWebSearchKey(provider, signal()))

    expect(error.kind).toBe('not_configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('AnySearch 没有 Key 也发一次搜索', async () => {
    configure({})
    fetchMock.mockResolvedValue(ok({ data: { results: [] } }))

    await testWebSearchKey('anysearch', signal())

    expect(fetchMock).toHaveBeenCalledWith('https://api.anysearch.com/v1/search', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ query: 'MintBot', max_results: 1 }) }, expect.any(AbortSignal))
  })

  it('HTTP 失败 → http 错误并带状态码', async () => {
    configure({ deepseekApiKey: 'k' })
    fetchMock.mockResolvedValue({ ok: false, kind: 'http', status: 401, message: 'bad' })

    const error = await failure(testWebSearchKey('deepseek', signal()))

    expect(error.kind).toBe('http')
    expect(error.status).toBe(401)
  })
})
