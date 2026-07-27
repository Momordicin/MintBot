import { describe, it, expect, vi, afterEach } from 'vitest'
import { Bert4NerProvider } from './NERProvider.js'
import { getLastActivityAt } from './aiActivity.js'

describe('Bert4NerProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('extractBatch 请求 /ner，body 为 {texts}，返回按输入顺序对齐的 results', async () => {
    const results = [
      [{ text: '北京', label: 'LOC', start: 0, end: 2 }],
      [],
    ]
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new Bert4NerProvider()
    const out = await provider.extractBatch(['北京欢迎你', '今天天气不错'])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8765/ner')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ texts: ['北京欢迎你', '今天天气不错'] })
    expect(out).toEqual(results)
  })

  it('extract 委托给 extractBatch([text])，返回 results[0]', async () => {
    const entities = [{ text: '张三', label: 'PER', start: 0, end: 2 }]
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [entities] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new Bert4NerProvider()
    const out = await provider.extract('张三来了')

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ texts: ['张三来了'] })
    expect(out).toEqual(entities)
  })

  it('响应非 ok 时抛出 [NER] HTTP {status} 错误', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new Bert4NerProvider()
    await expect(provider.extractBatch(['x'])).rejects.toThrow('[NER] HTTP 503')
  })
})

describe('Bert4NerProvider — 共享活动追踪（aiActivity）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('extractBatch 在发起 fetch 之前就记录了一次活动', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [[]] }),
    }))

    const before = Date.now()
    const provider = new Bert4NerProvider()
    await provider.extractBatch(['文本'])

    expect(getLastActivityAt()).toBeGreaterThanOrEqual(before)
  })

  it('extract（委托给 extractBatch）同样会记录活动', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [[]] }),
    }))

    const before = Date.now()
    const provider = new Bert4NerProvider()
    await provider.extract('文本')

    expect(getLastActivityAt()).toBeGreaterThanOrEqual(before)
  })
})

describe('Bert4NerProvider.unload', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POST {baseUrl}/ner/unload，返回响应体里的 unloaded 布尔值', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ unloaded: true }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new Bert4NerProvider()
    const result = await provider.unload()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8765/ner/unload')
    expect(init.method).toBe('POST')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(result).toBe(true)
  })

  it('响应非 ok 时抛出 [NER] HTTP {status} 错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))

    const provider = new Bert4NerProvider()
    await expect(provider.unload()).rejects.toThrow('[NER] HTTP 503')
  })
})
