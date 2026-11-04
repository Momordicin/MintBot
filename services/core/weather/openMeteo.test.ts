import { describe, it, expect, afterEach, vi } from 'vitest'
import { geocode, probeCurrent } from './openMeteo.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function hangingFetch() {
  return vi.fn((_url: URL, init: { signal: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason))
    })
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('geocode', () => {
  it('按参数请求地名查询并解析结果，缺失字段为 undefined', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      results: [
        { id: 5392171, name: 'San Jose', admin1: 'California', admin2: 'Santa Clara', country: 'United States', country_code: 'US', latitude: 37.33939, longitude: -121.89496, timezone: 'America/Los_Angeles', feature_code: 'PPLA2', population: 1000000 },
        { id: 2, name: 'Nowhere', latitude: 1, longitude: 2 },
        { name: 'no id', latitude: 1, longitude: 2 },
      ],
    }))
    vi.stubGlobal('fetch', fetchMock)

    const results = await geocode('San Jose, California', { language: 'en', countryCode: 'US', count: 10, signal: new AbortController().signal })

    const url = fetchMock.mock.calls[0][0] as URL
    expect(url.origin + url.pathname).toBe('https://geocoding-api.open-meteo.com/v1/search')
    expect(url.searchParams.get('name')).toBe('San Jose, California')
    expect(url.searchParams.get('count')).toBe('10')
    expect(url.searchParams.get('language')).toBe('en')
    expect(url.searchParams.get('countryCode')).toBe('US')
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ id: 5392171, name: 'San Jose', admin1: 'California', country_code: 'US', population: 1000000 })
    expect(results[1]).toEqual({
      id: 2, name: 'Nowhere', admin1: undefined, admin2: undefined, country: undefined, country_code: undefined,
      latitude: 1, longitude: 2, timezone: undefined, feature_code: undefined, population: undefined,
    })
  })

  it('不传 countryCode 时不带该参数，没有 results 时返回空数组', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ generationtime_ms: 1 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await geocode('Nowhere', { language: 'zh', count: 5, signal: new AbortController().signal })).toEqual([])
    expect((fetchMock.mock.calls[0][0] as URL).searchParams.has('countryCode')).toBe(false)
  })

  it('非 200 时抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 500)))

    await expect(geocode('x', { language: 'en', count: 1, signal: new AbortController().signal })).rejects.toThrow('HTTP 500')
  })

  it('10 秒无响应时超时', async () => {
    const timeoutController = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal)
    vi.stubGlobal('fetch', hangingFetch())

    const pending = geocode('x', { language: 'en', count: 1, signal: new AbortController().signal })
    timeoutController.abort(new DOMException('timed out', 'TimeoutError'))

    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(timeoutSpy).toHaveBeenCalledWith(10000)
  })

  it('调用方取消时中止请求', async () => {
    const caller = new AbortController()
    vi.stubGlobal('fetch', hangingFetch())

    const pending = geocode('x', { language: 'en', count: 1, signal: caller.signal })
    caller.abort(new Error('caller aborted'))

    await expect(pending).rejects.toThrow('caller aborted')
  })
})

describe('probeCurrent', () => {
  it('请求当前气温，有效数值时返回 true', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ current: { temperature_2m: 18.4 } }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await probeCurrent(37.33939, -121.89496, new AbortController().signal)).toBe(true)

    const url = fetchMock.mock.calls[0][0] as URL
    expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast')
    expect(url.searchParams.get('latitude')).toBe('37.33939')
    expect(url.searchParams.get('longitude')).toBe('-121.89496')
    expect(url.searchParams.get('current')).toBe('temperature_2m')
    expect(url.searchParams.get('timezone')).toBe('auto')
  })

  it('没有有效气温值时抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ current: {} })))

    await expect(probeCurrent(1, 2, new AbortController().signal)).rejects.toThrow('no current temperature')
  })

  it('非 200 时抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 429)))

    await expect(probeCurrent(1, 2, new AbortController().signal)).rejects.toThrow('HTTP 429')
  })

  it('10 秒超时与调用方取消', async () => {
    const timeoutController = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal)
    vi.stubGlobal('fetch', hangingFetch())
    const timedOut = probeCurrent(1, 2, new AbortController().signal)
    timeoutController.abort(new DOMException('timed out', 'TimeoutError'))
    await expect(timedOut).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(timeoutSpy).toHaveBeenCalledWith(10000)

    timeoutSpy.mockRestore()
    const caller = new AbortController()
    const aborted = probeCurrent(1, 2, caller.signal)
    caller.abort(new Error('caller aborted'))
    await expect(aborted).rejects.toThrow('caller aborted')
  })
})
