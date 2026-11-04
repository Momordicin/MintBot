// services/core/tools/rememberLocation.ts — 工具 remember_location：按英文县市名查出地点与坐标，用该坐标试取一次天气，成功后写入用户资料
// 用法：tools/index.ts 注册 REMEMBER_LOCATION_SCHEMA 并调 runRememberLocation(args, chatSignal)；查询走 weather/openMeteo.ts，写入走 profile/userProfile.ts 的 setLocation
// 对应文件：services/core/tools/index.ts / services/core/weather/openMeteo.ts / services/core/profile/userProfile.ts / services/core/tools/rememberLocation.test.ts
import type { ToolSchema } from '../../../shared/types/index.js'
import { setLocation } from '../profile/userProfile.js'
import { geocode, probeCurrent, type GeocodeResult } from '../weather/openMeteo.js'

const RUN_TIMEOUT_MS = 20000
const GEOCODE_COUNT = 10
const MAX_CANDIDATES = 5
const POPULATION_DOMINANCE = 10
const DISTRICT_MAX_KM = 30

export const REMEMBER_LOCATION_SCHEMA: ToolSchema = {
  name: 'remember_location',
  description: '用户告诉你所在城市或地区、住址，或者说搬家了时调用。地名必须用英文并带上州或省。',
  parameters: {
    type: 'object',
    properties: {
      place: { type: 'string', description: '用户的原话' },
      city: { type: 'string', description: '县市一级的英文名，带上州或省，例如 "San Jose, California"、"Shenzhen, Guangdong"' },
      district: { type: 'string', description: '区县一级的英文名，带上省或州，例如 "Futian, Guangdong"；用户没说到区县时不传' },
      country_code: { type: 'string', description: '国家的两位字母代码（ISO 3166-1 alpha-2），例如 "US"、"CN"；不确定时不传' },
      address: { type: 'string', description: '用户说出的精确地址（如住址），原样传入；用户没说时不传' },
    },
    required: ['place', 'city'],
  },
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isPopulatedPlace(result: GeocodeResult): boolean {
  return result.feature_code?.startsWith('PPL') === true
}

function regionKey(result: GeocodeResult): string {
  return `${result.country_code ?? ''}|${result.admin1 ?? ''}`
}

function joinName(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => !!part).join(', ')
}

function describe(result: GeocodeResult): string {
  return joinName([result.name, result.admin1, result.country])
}

function distanceKm(a: GeocodeResult, b: GeocodeResult): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.latitude - a.latitude)
  const dLon = toRad(b.longitude - a.longitude)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}

function pickCity(candidates: GeocodeResult[]): GeocodeResult | null {
  const first = candidates[0]
  const others = candidates.filter(c => regionKey(c) !== regionKey(first))
  if (others.length === 0) return first
  const otherPopulations = others.map(c => c.population).filter((p): p is number => p !== undefined)
  if (otherPopulations.length === 0) return first
  if (first.population !== undefined && first.population >= POPULATION_DOMINANCE * Math.max(...otherPopulations)) return first
  return null
}

function isWithinCity(district: GeocodeResult, city: GeocodeResult): boolean {
  return district.admin1 === city.admin1
    && (!district.admin2 || district.admin2 === city.admin2)
    && distanceKm(district, city) <= DISTRICT_MAX_KM
}

async function chineseMatch(target: GeocodeResult, signal: AbortSignal, chatSignal: AbortSignal): Promise<GeocodeResult | null> {
  try {
    const results = await geocode(target.name, { language: 'zh', countryCode: target.country_code, count: GEOCODE_COUNT, signal })
    return results.find(r => r.id === target.id) ?? null
  } catch (err) {
    if (chatSignal.aborted) throw err
    return null
  }
}

const NEED_CONFIRM_INSTRUCTION = '用你自己的口吻请用户确认是哪一个，不要替用户选。'
const NOT_FOUND = JSON.stringify({ status: 'not_found', instruction: '请用户换个说法，或者说出所在的省或州。' })
const FAILED = JSON.stringify({ status: 'failed', instruction: '如实告诉用户暂时没能记下。' })

export async function runRememberLocation(args: Record<string, unknown>, chatSignal: AbortSignal): Promise<string> {
  const place = asText(args.place)
  const city = asText(args.city)
  if (!place || !city) return '参数无效：需要 place 和 city'
  const district = asText(args.district)
  const rawCountryCode = asText(args.country_code).toUpperCase()
  const countryCode = /^[A-Z]{2}$/.test(rawCountryCode) ? rawCountryCode : undefined
  const address = asText(args.address)
  const signal = AbortSignal.any([chatSignal, AbortSignal.timeout(RUN_TIMEOUT_MS)])

  try {
    const candidates = (await geocode(city, { language: 'en', countryCode, count: GEOCODE_COUNT, signal })).filter(isPopulatedPlace)
    if (candidates.length === 0) return NOT_FOUND
    const cityResult = pickCity(candidates)
    if (!cityResult) {
      return JSON.stringify({
        status: 'need_confirm',
        candidates: [...new Set(candidates.map(describe))].slice(0, MAX_CANDIDATES),
        instruction: NEED_CONFIRM_INSTRUCTION,
      })
    }

    let chosen = cityResult
    if (district) {
      const districts = (await geocode(district, { language: 'en', countryCode: cityResult.country_code, count: GEOCODE_COUNT, signal })).filter(isPopulatedPlace)
      chosen = districts.find(d => isWithinCity(d, cityResult)) ?? cityResult
    }

    await probeCurrent(chosen.latitude, chosen.longitude, signal)
    const isDistrict = chosen.id !== cityResult.id && chosen.name !== cityResult.name
    const zhChosen = await chineseMatch(chosen, signal, chatSignal)
    const zhCity = isDistrict ? await chineseMatch(cityResult, signal, chatSignal) : null

    if (chatSignal.aborted) return FAILED
    const value = isDistrict
      ? joinName([chosen.name, cityResult.name, chosen.admin1, chosen.country])
      : describe(chosen)
    const zhRegion = zhChosen ?? zhCity
    const nameZh = !zhRegion
      ? value
      : isDistrict
        ? joinName([zhChosen?.name ?? chosen.name, zhCity?.name ?? cityResult.name, zhRegion.admin1 ?? chosen.admin1, zhRegion.country ?? chosen.country])
        : describe(zhRegion)
    setLocation({
      value,
      userInput: place,
      nameZh,
      latitude: chosen.latitude,
      longitude: chosen.longitude,
      timezone: chosen.timezone,
      countryCode: chosen.country_code,
      exactAddress: address || null,
    })
    return JSON.stringify({ status: 'ok', place: value, instruction: '已记下用户所在地，用你自己的口吻简短回应。' })
  } catch (err) {
    if (!chatSignal.aborted) {
      console.error('[RememberLocation] failed:', err, `(place=${JSON.stringify(place)})`)
    }
    return FAILED
  }
}
