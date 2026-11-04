// services/core/weather/openMeteo.ts — Open-Meteo 地名查询与坐标天气探测的 HTTP 封装
// 用法：tools/rememberLocation.ts 调 geocode(name, options) 查地名，再调 probeCurrent(lat, lon, signal) 试取一次当前气温
// 对应文件：services/core/tools/rememberLocation.ts / services/core/weather/openMeteo.test.ts
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const REQUEST_TIMEOUT_MS = 10000

export interface GeocodeResult {
  id: number
  name: string
  admin1: string | undefined
  admin2: string | undefined
  country: string | undefined
  country_code: string | undefined
  latitude: number
  longitude: number
  timezone: string | undefined
  feature_code: string | undefined
  population: number | undefined
}

export interface GeocodeOptions {
  language: string
  countryCode?: string
  count: number
  signal: AbortSignal
}

async function getJson(url: URL, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) })
  if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`)
  return response.json()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export async function geocode(name: string, options: GeocodeOptions): Promise<GeocodeResult[]> {
  const url = new URL(GEOCODING_URL)
  url.searchParams.set('name', name)
  url.searchParams.set('count', String(options.count))
  url.searchParams.set('language', options.language)
  url.searchParams.set('format', 'json')
  if (options.countryCode) url.searchParams.set('countryCode', options.countryCode)

  const body = (await getJson(url, options.signal)) as { results?: Record<string, unknown>[] }
  const results: GeocodeResult[] = []
  for (const item of body.results ?? []) {
    const latitude = optionalNumber(item.latitude)
    const longitude = optionalNumber(item.longitude)
    const id = optionalNumber(item.id)
    const itemName = optionalString(item.name)
    if (id === undefined || itemName === undefined || latitude === undefined || longitude === undefined) continue
    results.push({
      id,
      name: itemName,
      admin1: optionalString(item.admin1),
      admin2: optionalString(item.admin2),
      country: optionalString(item.country),
      country_code: optionalString(item.country_code),
      latitude,
      longitude,
      timezone: optionalString(item.timezone),
      feature_code: optionalString(item.feature_code),
      population: optionalNumber(item.population),
    })
  }
  return results
}

export async function probeCurrent(latitude: number, longitude: number, signal: AbortSignal): Promise<true> {
  const url = new URL(FORECAST_URL)
  url.searchParams.set('latitude', String(latitude))
  url.searchParams.set('longitude', String(longitude))
  url.searchParams.set('current', 'temperature_2m')
  url.searchParams.set('timezone', 'auto')

  const body = (await getJson(url, signal)) as { current?: { temperature_2m?: unknown } }
  if (optionalNumber(body.current?.temperature_2m) === undefined) throw new Error('Open-Meteo returned no current temperature')
  return true
}
