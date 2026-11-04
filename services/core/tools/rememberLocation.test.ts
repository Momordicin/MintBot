import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'

const { geocodeMock, probeMock } = vi.hoisted(() => ({
  geocodeMock: vi.fn(),
  probeMock: vi.fn(),
}))
vi.mock('../weather/openMeteo.js', () => ({
  geocode: geocodeMock,
  probeCurrent: probeMock,
}))

const { runRememberLocation, REMEMBER_LOCATION_SCHEMA } = await import('./rememberLocation.js')
const { USER_PROFILE_PATH, getLocation, setLocation } = await import('../profile/userProfile.js')

function place(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'San Jose',
    admin1: 'California',
    admin2: 'Santa Clara',
    country: 'United States',
    country_code: 'US',
    latitude: 37.33939,
    longitude: -121.89496,
    timezone: 'America/Los_Angeles',
    feature_code: 'PPLA2',
    population: 1000000,
    ...overrides,
  }
}

const SAN_JOSE_ZH = place({ name: '聖荷西', admin1: '加州', country: '美国' })

function geocodeByLanguage(en: unknown[], zh: unknown[] = []) {
  geocodeMock.mockImplementation(async (_name: string, options: { language: string }) => (options.language === 'zh' ? zh : en))
}

beforeEach(() => {
  fs.rmSync(USER_PROFILE_PATH, { force: true })
  geocodeMock.mockReset()
  probeMock.mockReset().mockResolvedValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('remember_location 工具定义', () => {
  it('名称、参数 schema 与描述', () => {
    expect(REMEMBER_LOCATION_SCHEMA.name).toBe('remember_location')
    expect(REMEMBER_LOCATION_SCHEMA.parameters).toMatchObject({
      required: ['place', 'city'],
      properties: { place: {}, city: {}, district: {}, country_code: {}, address: {} },
    })
    expect(REMEMBER_LOCATION_SCHEMA.description).toBe('用户告诉你所在城市或地区、住址，或者说搬家了时调用。地名必须用英文并带上州或省。')
  })
})

describe('runRememberLocation', () => {
  it('单个结果：查询、探测天气、写入新格式并返回 ok', async () => {
    geocodeByLanguage([place()], [SAN_JOSE_ZH])

    const result = await runRememberLocation(
      { place: '我在圣何塞', city: 'San Jose, California', country_code: 'us', address: '1 Market St' },
      new AbortController().signal
    )

    expect(JSON.parse(result)).toEqual({ status: 'ok', place: 'San Jose, California, United States', instruction: '已记下用户所在地，用你自己的口吻简短回应。' })
    expect(geocodeMock.mock.calls[0][0]).toBe('San Jose, California')
    expect(geocodeMock.mock.calls[0][1]).toMatchObject({ language: 'en', countryCode: 'US', count: 10 })
    expect(geocodeMock.mock.calls[1][0]).toBe('San Jose')
    expect(geocodeMock.mock.calls[1][1]).toMatchObject({ language: 'zh', countryCode: 'US', count: 10 })
    expect(probeMock.mock.calls[0].slice(0, 2)).toEqual([37.33939, -121.89496])

    expect(getLocation()).toMatchObject({
      value: 'San Jose, California, United States',
      nameZh: '聖荷西, 加州, 美国',
      latitude: 37.33939,
      longitude: -121.89496,
      timezone: 'America/Los_Angeles',
      countryCode: 'US',
      exactAddress: '1 Market St',
      userInput: '我在圣何塞',
    })
    const text = fs.readFileSync(USER_PROFILE_PATH, 'utf8')
    expect(text).toContain('## 所在地\n- 当前：San Jose, California, United States\n- 中文名：聖荷西, 加州, 美国\n- 坐标：37.33939, -121.89496\n- 时区：America/Los_Angeles\n- 国家代码：US\n- 精确地址：1 Market St\n- 用户原话：我在圣何塞\n- 记下时间：')
  })

  it('没有地址时不写精确地址行', async () => {
    geocodeByLanguage([place()], [SAN_JOSE_ZH])

    await runRememberLocation({ place: '圣何塞', city: 'San Jose, California', address: '  ' }, new AbortController().signal)

    expect(fs.readFileSync(USER_PROFILE_PATH, 'utf8')).not.toContain('精确地址')
    expect(getLocation()?.exactAddress).toBeNull()
  })

  it('同一州的多个结果取第一个', async () => {
    geocodeByLanguage([place(), place({ id: 2, name: 'San Jose Village', population: 10 })], [SAN_JOSE_ZH])

    const result = JSON.parse(await runRememberLocation({ place: '圣何塞', city: 'San Jose, California' }, new AbortController().signal))

    expect(result.status).toBe('ok')
    expect(getLocation()?.value).toBe('San Jose, California, United States')
  })

  it('美国与哥斯达黎加同名且人口接近时需要用户确认，不写入', async () => {
    geocodeByLanguage([
      place(),
      place({ id: 3, name: 'San José', admin1: 'San José', admin2: undefined, country: 'Costa Rica', country_code: 'CR', population: 340000 }),
    ])

    const result = JSON.parse(await runRememberLocation({ place: '圣何塞', city: 'San Jose' }, new AbortController().signal))

    expect(result).toEqual({
      status: 'need_confirm',
      candidates: ['San Jose, California, United States', 'San José, San José, Costa Rica'],
      instruction: '用你自己的口吻请用户确认是哪一个，不要替用户选。',
    })
    expect(probeMock).not.toHaveBeenCalled()
    expect(getLocation()).toBeNull()
  })

  it('候选最多列 5 个', async () => {
    const many = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((admin1, index) => place({ id: 10 + index, admin1, country_code: `X${index}`, population: 100 }))
    geocodeByLanguage(many)

    const result = JSON.parse(await runRememberLocation({ place: 'x', city: 'San Jose' }, new AbortController().signal))

    expect(result.status).toBe('need_confirm')
    expect(result.candidates).toHaveLength(5)
  })

  it('第一个的人口至少是其他地区最大人口的 10 倍时取第一个', async () => {
    geocodeByLanguage([
      place({ id: 4, name: 'Shanghai', admin1: 'Shanghai', admin2: undefined, country: 'China', country_code: 'CN', population: 24000000 }),
      place({ id: 5, name: 'Shanghai', admin1: 'Other', admin2: undefined, country: 'Elsewhere', country_code: 'EL', population: 2000000 }),
    ])

    const result = JSON.parse(await runRememberLocation({ place: '上海', city: 'Shanghai' }, new AbortController().signal))

    expect(result.status).toBe('ok')
    expect(result.place).toBe('Shanghai, Shanghai, China')
  })

  it('其他地区都没有人口数据时取第一个', async () => {
    geocodeByLanguage([place(), place({ id: 6, admin1: 'Elsewhere', country_code: 'EL', population: undefined })])

    expect(JSON.parse(await runRememberLocation({ place: 'x', city: 'San Jose' }, new AbortController().signal)).status).toBe('ok')
  })

  it('过滤掉非居民点；只剩非居民点时返回 not_found', async () => {
    geocodeByLanguage([place({ id: 7, feature_code: 'AIRP' }), place({ id: 8, feature_code: 'MTS' })])

    const result = JSON.parse(await runRememberLocation({ place: 'x', city: 'San Jose' }, new AbortController().signal))

    expect(result).toEqual({ status: 'not_found', instruction: '请用户换个说法，或者说出所在的省或州。' })
    expect(getLocation()).toBeNull()
  })

  it('非居民点被跳过，PPLX 保留', async () => {
    geocodeByLanguage([place({ id: 7, name: 'Airport', feature_code: 'AIRP' }), place({ id: 9, feature_code: 'PPLX' })], [place({ id: 9, name: '聖荷西', admin1: '加州', country: '美国' })])

    const result = JSON.parse(await runRememberLocation({ place: 'x', city: 'San Jose' }, new AbortController().signal))

    expect(result.status).toBe('ok')
    expect(result.place).toBe('San Jose, California, United States')
  })

  it('没有任何结果时返回 not_found', async () => {
    geocodeByLanguage([])

    expect(JSON.parse(await runRememberLocation({ place: 'x', city: 'Nowhere' }, new AbortController().signal)).status).toBe('not_found')
  })

  describe('区县', () => {
    const shenzhen = place({ id: 100, name: 'Shenzhen', admin1: 'Guangdong', admin2: undefined, country: 'China', country_code: 'CN', latitude: 22.54554, longitude: 114.0683, timezone: 'Asia/Shanghai', population: 17000000 })
    const futian = (overrides: Record<string, unknown> = {}) => place({ id: 101, name: 'Futian', admin1: 'Guangdong', admin2: undefined, country: 'China', country_code: 'CN', latitude: 22.52, longitude: 114.05, timezone: 'Asia/Shanghai', population: undefined, ...overrides })

    function geocodeCityAndDistrict(districtResults: unknown[]) {
      geocodeMock.mockImplementation(async (name: string, options: { language: string }) => {
        if (options.language === 'zh') return []
        return name.startsWith('Futian') ? districtResults : [shenzhen]
      })
    }

    it('30 公里以内且属于同一省：采用区县名称与坐标', async () => {
      geocodeCityAndDistrict([futian()])

      const result = JSON.parse(await runRememberLocation({ place: '深圳福田', city: 'Shenzhen, Guangdong', district: 'Futian, Guangdong', country_code: 'CN' }, new AbortController().signal))

      expect(result.place).toBe('Futian, Shenzhen, Guangdong, China')
      expect(geocodeMock.mock.calls[1][1]).toMatchObject({ language: 'en', countryCode: 'CN', count: 10 })
      expect(probeMock.mock.calls[0].slice(0, 2)).toEqual([22.52, 114.05])
      expect(getLocation()).toMatchObject({ latitude: 22.52, longitude: 114.05 })
    })

    it('超过 30 公里：沿用县市', async () => {
      geocodeCityAndDistrict([futian({ latitude: 23.5, longitude: 114.05 })])

      await runRememberLocation({ place: '深圳福田', city: 'Shenzhen, Guangdong', district: 'Futian, Guangdong' }, new AbortController().signal)

      expect(getLocation()).toMatchObject({ value: 'Shenzhen, Guangdong, China', latitude: 22.54554, longitude: 114.0683 })
    })

    it('省不同：沿用县市；同名村庄被跳过后取下一个符合的', async () => {
      geocodeCityAndDistrict([futian({ id: 102, admin1: 'Hunan' })])
      await runRememberLocation({ place: '福田', city: 'Shenzhen, Guangdong', district: 'Futian, Guangdong' }, new AbortController().signal)
      expect(getLocation()?.value).toBe('Shenzhen, Guangdong, China')

      geocodeCityAndDistrict([futian({ id: 102, admin1: 'Hunan' }), futian()])
      await runRememberLocation({ place: '福田', city: 'Shenzhen, Guangdong', district: 'Futian, Guangdong' }, new AbortController().signal)
      expect(getLocation()?.value).toBe('Futian, Shenzhen, Guangdong, China')
    })

    it('区县查到的就是县市本身，或与县市同名：名称不重复', async () => {
      geocodeMock.mockImplementation(async (_name: string, options: { language: string }) => (options.language === 'zh' ? [] : [{ ...shenzhen }]))
      await runRememberLocation({ place: '深圳', city: 'Shenzhen, Guangdong', district: 'Shenzhen, Guangdong' }, new AbortController().signal)
      expect(getLocation()?.value).toBe('Shenzhen, Guangdong, China')

      geocodeMock.mockImplementation(async (name: string, options: { language: string }) => {
        if (options.language === 'zh') return []
        return name.startsWith('District') ? [{ ...shenzhen, id: 555 }] : [shenzhen]
      })
      await runRememberLocation({ place: '深圳', city: 'Shenzhen, Guangdong', district: 'District Shenzhen' }, new AbortController().signal)
      expect(getLocation()?.value).toBe('Shenzhen, Guangdong, China')
    })

    it('采用区县时中文名同样带上所属县市', async () => {
      geocodeMock.mockImplementation(async (name: string, options: { language: string }) => {
        if (options.language === 'zh') {
          return name === 'Futian'
            ? [futian({ name: '福田', admin1: '广东', country: '中国' })]
            : [{ ...shenzhen, name: '深圳', admin1: '广东', country: '中国' }]
        }
        return name.startsWith('Futian') ? [futian()] : [shenzhen]
      })

      await runRememberLocation({ place: '深圳福田', city: 'Shenzhen, Guangdong', district: 'Futian, Guangdong' }, new AbortController().signal)

      expect(getLocation()).toMatchObject({ value: 'Futian, Shenzhen, Guangdong, China', nameZh: '福田, 深圳, 广东, 中国' })
    })

    it('区县的 admin2 与县市不同：沿用县市', async () => {
      geocodeCityAndDistrict([futian({ admin2: 'Other' })])

      await runRememberLocation({ place: '福田', city: 'Shenzhen, Guangdong', district: 'Futian, Guangdong' }, new AbortController().signal)

      expect(getLocation()?.value).toBe('Shenzhen, Guangdong, China')
    })

    it('区县不是居民点：沿用县市', async () => {
      geocodeCityAndDistrict([futian({ feature_code: 'MTS' })])

      await runRememberLocation({ place: '福田', city: 'Shenzhen, Guangdong', district: 'Futian, Guangdong' }, new AbortController().signal)

      expect(getLocation()?.value).toBe('Shenzhen, Guangdong, China')
    })
  })

  it('天气探测失败时不写入，已有的所在地不变，并记录日志', async () => {
    setLocation({ value: 'Old, Place', userInput: '旧' })
    geocodeByLanguage([place()], [SAN_JOSE_ZH])
    probeMock.mockRejectedValue(new Error('HTTP 500'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = JSON.parse(await runRememberLocation({ place: '圣何塞', city: 'San Jose, California' }, new AbortController().signal))

    expect(result).toEqual({ status: 'failed', instruction: '如实告诉用户暂时没能记下。' })
    expect(getLocation()?.value).toBe('Old, Place')
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('查询地名失败时返回 failed 并记录日志', async () => {
    geocodeMock.mockRejectedValue(new Error('network'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(JSON.parse(await runRememberLocation({ place: 'x', city: 'San Jose' }, new AbortController().signal)).status).toBe('failed')
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('找不到中文名时用英文名作中文名', async () => {
    geocodeByLanguage([place()], [place({ id: 999, name: '别处' })])

    await runRememberLocation({ place: '圣何塞', city: 'San Jose, California' }, new AbortController().signal)

    expect(getLocation()?.nameZh).toBe('San Jose, California, United States')
  })

  it('中文名查询失败时同样用英文名，仍写入', async () => {
    geocodeMock.mockImplementation(async (_name: string, options: { language: string }) => {
      if (options.language === 'zh') throw new Error('zh down')
      return [place()]
    })

    const result = JSON.parse(await runRememberLocation({ place: '圣何塞', city: 'San Jose, California' }, new AbortController().signal))

    expect(result.status).toBe('ok')
    expect(getLocation()?.nameZh).toBe('San Jose, California, United States')
  })

  it('运行中请求被取消：不写入且不记日志', async () => {
    const chat = new AbortController()
    geocodeMock.mockImplementation((_name: string, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason))
      })
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const pending = runRememberLocation({ place: 'x', city: 'San Jose' }, chat.signal)
    await vi.waitFor(() => expect(geocodeMock).toHaveBeenCalled())
    chat.abort()

    expect(JSON.parse(await pending).status).toBe('failed')
    expect(errorSpy).not.toHaveBeenCalled()
    expect(getLocation()).toBeNull()
  })

  it('写入前请求已取消：不写入', async () => {
    const chat = new AbortController()
    geocodeByLanguage([place()], [SAN_JOSE_ZH])
    probeMock.mockImplementation(async () => {
      chat.abort()
      return true
    })

    const result = JSON.parse(await runRememberLocation({ place: 'x', city: 'San Jose' }, chat.signal))

    expect(result.status).toBe('failed')
    expect(getLocation()).toBeNull()
  })

  it('整个流程 20 秒超时：不写入并记录日志', async () => {
    const timeoutController = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal)
    geocodeMock.mockImplementation((_name: string, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason))
      })
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const pending = runRememberLocation({ place: 'x', city: 'San Jose' }, new AbortController().signal)
    await vi.waitFor(() => expect(geocodeMock).toHaveBeenCalled())
    timeoutController.abort(new DOMException('timed out', 'TimeoutError'))

    expect(JSON.parse(await pending).status).toBe('failed')
    expect(AbortSignal.timeout).toHaveBeenCalledWith(20000)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(getLocation()).toBeNull()
  })

  it('20 秒时限在查中文名时用完：仍用英文名写入', async () => {
    const timeoutController = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal)
    geocodeMock.mockImplementation((_name: string, options: { language: string; signal: AbortSignal }) => {
      if (options.language === 'en') return Promise.resolve([place()])
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason))
      })
    })

    const pending = runRememberLocation({ place: '圣何塞', city: 'San Jose, California' }, new AbortController().signal)
    await vi.waitFor(() => expect(geocodeMock).toHaveBeenCalledTimes(2))
    timeoutController.abort(new DOMException('timed out', 'TimeoutError'))

    expect(JSON.parse(await pending).status).toBe('ok')
    expect(getLocation()).toMatchObject({ value: 'San Jose, California, United States', nameZh: 'San Jose, California, United States' })
  })

  it('country_code 不是两个字母时当作未提供', async () => {
    geocodeByLanguage([place()], [SAN_JOSE_ZH])

    await runRememberLocation({ place: '圣何塞', city: 'San Jose, California', country_code: 'USA' }, new AbortController().signal)

    expect(geocodeMock.mock.calls[0][1].countryCode).toBeUndefined()
  })

  it('需要确认时候选按显示名去重', async () => {
    geocodeByLanguage([
      place(),
      place({ id: 2, latitude: 37.4 }),
      place({ id: 3, name: 'San José', admin1: 'San José', country: 'Costa Rica', country_code: 'CR', population: 335007 }),
    ])

    const result = JSON.parse(await runRememberLocation({ place: 'San Jose', city: 'San Jose' }, new AbortController().signal))

    expect(result.status).toBe('need_confirm')
    expect(result.candidates).toEqual(['San Jose, California, United States', 'San José, San José, Costa Rica'])
  })

  it('成功时不记录日志', async () => {
    geocodeByLanguage([place()], [SAN_JOSE_ZH])
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await runRememberLocation({ place: '圣何塞', city: 'San Jose, California' }, new AbortController().signal)

    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('缺少 place 或 city 时不发起查询', async () => {
    expect(await runRememberLocation({ city: 'San Jose' }, new AbortController().signal)).toBe('参数无效：需要 place 和 city')
    expect(await runRememberLocation({ place: 'x' }, new AbortController().signal)).toBe('参数无效：需要 place 和 city')
    expect(geocodeMock).not.toHaveBeenCalled()
  })
})
