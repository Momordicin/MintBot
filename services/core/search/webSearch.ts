// services/core/search/webSearch.ts — 联网搜索服务：按设置里的顺序调用 DeepSeek 搜索 / Tavily / AnySearch / Claude Code 订阅 / Codex 订阅之一，返回统一的结果格式
// 用法：core 内业务调 webSearch({ query, count?, subscriptionPrompt?, signal })；routes/config.ts 的 POST /config/web-search/test 调 testWebSearchKey(provider, signal)；顺序、Key、地区读 getWebSearchConfig
// 对应文件：services/core/routes/config.ts / services/core/plugins/pluginFetch.ts / services/core/agents/claudeCode.ts / services/core/agents/codex.ts / services/core/config/index.ts / services/core/search/webSearch.test.ts
import { claudeWebSearch } from '../agents/claudeCode.js'
import { codexWebSearch } from '../agents/codex.js'
import { getWebSearchConfig } from '../config/index.js'
import { createPluginFetch, type FetchResult, type PluginFetch, type PluginFetchStandard } from '../plugins/pluginFetch.js'
import type { WebSearchProvider } from '../../../shared/types/index.js'

export type WebSearchErrorKind = 'not_configured' | 'invalid_query' | 'http' | 'timeout' | 'connect' | 'invalid_response' | 'aborted'

export class WebSearchError extends Error {
  constructor(readonly kind: WebSearchErrorKind, message: string, readonly status?: number) {
    super(message)
  }
}

export interface WebSearchItem {
  title: string
  url: string
  snippet: string
  summary?: string
  publishedAt?: string
}

export interface WebSearchResult {
  provider: WebSearchProvider
  query: string
  results: WebSearchItem[]
  answer?: string
}

export interface WebSearchParams {
  query: string
  count?: number
  subscriptionPrompt?: string
  signal: AbortSignal
}

type HttpProvider = 'deepseek' | 'tavily' | 'anysearch'
type SubscriptionProvider = 'claude' | 'codex'

interface HttpRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

type Parsed = Pick<WebSearchResult, 'results' | 'answer'>

const LABEL: Record<WebSearchProvider, string> = {
  deepseek: 'DeepSeek 搜索',
  tavily: 'Tavily',
  anysearch: 'AnySearch',
  claude: 'Claude Code 订阅',
  codex: 'Codex 订阅',
}

const COUNT_RANGE: Partial<Record<WebSearchProvider, readonly [number, number]>> = {
  deepseek: [1, 50],
  tavily: [1, 20],
  anysearch: [1, 10],
}

const DEEPSEEK_MAX_QUERY_LENGTH = 128
const SUBSCRIPTION_TIMEOUT_MS = 60000

const STANDARD: PluginFetchStandard = {
  retries: 1,
  retry_delay_ms: 500,
  request_timeout_ms: 10000,
  connect_attempt_timeout_ms: 1000,
}

const fetchers = new Map<HttpProvider, PluginFetch>()

function fetcherFor(provider: HttpProvider): PluginFetch {
  let fetcher = fetchers.get(provider)
  if (!fetcher) {
    fetcher = createPluginFetch(STANDARD)
    fetchers.set(provider, fetcher)
  }
  return fetcher
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function invalidResponse(provider: WebSearchProvider, reason: string): WebSearchError {
  return new WebSearchError('invalid_response', `${LABEL[provider]}：返回格式不对，${reason}`)
}

function aborted(): WebSearchError {
  return new WebSearchError('aborted', '搜索已中止')
}

function missingKey(provider: WebSearchProvider): WebSearchError {
  return new WebSearchError('not_configured', `${LABEL[provider]}：还没有填写 API Key`)
}

function checkRequest(provider: WebSearchProvider, query: string, count: number | undefined): void {
  if (provider === 'deepseek' && [...query].length > DEEPSEEK_MAX_QUERY_LENGTH) {
    throw new WebSearchError('invalid_query', `${LABEL[provider]}：搜索词不能超过 ${DEEPSEEK_MAX_QUERY_LENGTH} 个字`)
  }
  const range = COUNT_RANGE[provider]
  if (count !== undefined && range && (!Number.isInteger(count) || count < range[0] || count > range[1])) {
    throw new WebSearchError('invalid_query', `${LABEL[provider]}：条数必须是 ${range[0]} 到 ${range[1]} 之间的整数`)
  }
}

function buildRequest(provider: HttpProvider, query: string, count: number | undefined): HttpRequest {
  const config = getWebSearchConfig()
  const json = { 'Content-Type': 'application/json' }
  if (provider === 'deepseek') {
    if (!config.deepseekApiKey) throw missingKey(provider)
    return {
      url: 'https://api.deepseek.com/v1/tools/search',
      headers: { ...json, Authorization: `Bearer ${config.deepseekApiKey}` },
      body: { query, ...(count !== undefined ? { count } : {}) },
    }
  }
  if (provider === 'tavily') {
    if (!config.tavilyApiKey) throw missingKey(provider)
    return {
      url: 'https://api.tavily.com/search',
      headers: { ...json, Authorization: `Bearer ${config.tavilyApiKey}` },
      body: { query, ...(count !== undefined ? { max_results: count } : {}) },
    }
  }
  return {
    url: 'https://api.anysearch.com/v1/search',
    headers: config.anysearchApiKey ? { ...json, Authorization: `Bearer ${config.anysearchApiKey}` } : json,
    body: {
      query,
      ...(count !== undefined ? { max_results: count } : {}),
      ...(config.anysearchZone !== null ? { zone: config.anysearchZone } : {}),
    },
  }
}

function fetchFailure(provider: WebSearchProvider, result: Extract<FetchResult, { ok: false }>): WebSearchError {
  const label = LABEL[provider]
  if (result.kind === 'aborted') return aborted()
  if (result.kind === 'http') return new WebSearchError('http', `${label}：请求失败（HTTP ${result.status ?? '未知'}）${result.message}`, result.status)
  if (result.kind === 'timeout') return new WebSearchError('timeout', `${label}：请求超时（${result.message}）`)
  return new WebSearchError('connect', `${label}：无法连接（${result.message}）`)
}

function parseList(provider: HttpProvider, list: unknown, pick: (item: Record<string, unknown>, url: string) => WebSearchItem): WebSearchItem[] {
  if (!Array.isArray(list)) throw invalidResponse(provider, '缺少结果数组')
  return list.map(item => {
    const url = isRecord(item) ? text(item.url) : undefined
    if (!isRecord(item) || url === undefined) throw invalidResponse(provider, '有结果缺少 url')
    return pick(item, url)
  })
}

function parseBody(provider: HttpProvider, body: unknown): Parsed {
  const root = isRecord(body) ? body : {}
  if (provider === 'deepseek') {
    return {
      results: parseList(provider, root.results, (item, url) => {
        const summary = text(item.summary)
        const publishedAt = text(item.date)
        return {
          title: text(item.title) ?? '',
          url,
          snippet: text(item.snippet) ?? '',
          ...(summary !== undefined ? { summary } : {}),
          ...(publishedAt !== undefined ? { publishedAt } : {}),
        }
      }),
    }
  }
  if (provider === 'tavily') {
    return { results: parseList(provider, root.results, (item, url) => ({ title: text(item.title) ?? '', url, snippet: text(item.content) ?? '' })) }
  }
  const data = isRecord(root.data) ? root.data : {}
  return { results: parseList(provider, data.results, (item, url) => ({ title: text(item.title) ?? '', url, snippet: text(item.snippet) ?? '' })) }
}

async function searchHttp(provider: HttpProvider, query: string, count: number | undefined, signal: AbortSignal): Promise<Parsed> {
  const request = buildRequest(provider, query, count)
  const result = await fetcherFor(provider)(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body) }, signal)
  if (!result.ok) throw fetchFailure(provider, result)
  let body: unknown
  try {
    body = JSON.parse(result.body)
  } catch {
    throw invalidResponse(provider, '不是有效的 JSON')
  }
  return parseBody(provider, body)
}

async function searchSubscription(provider: SubscriptionProvider, prompt: string, signal: AbortSignal): Promise<Parsed> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), SUBSCRIPTION_TIMEOUT_MS)
  const call = provider === 'claude' ? claudeWebSearch : codexWebSearch
  try {
    const { text: answer } = await call({ query: prompt, signal: AbortSignal.any([signal, timeout.signal]) })
    return { results: [], answer }
  } catch (err) {
    if (signal.aborted) throw aborted()
    if (timeout.signal.aborted) throw new WebSearchError('timeout', `${LABEL[provider]}：超过 ${SUBSCRIPTION_TIMEOUT_MS / 1000} 秒没有返回`)
    throw new WebSearchError('connect', `${LABEL[provider]}：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
  }
}

async function searchWith(provider: WebSearchProvider, query: string, count: number | undefined, subscriptionPrompt: string | undefined, signal: AbortSignal): Promise<WebSearchResult> {
  checkRequest(provider, query, count)
  const parsed = provider === 'claude' || provider === 'codex'
    ? await searchSubscription(provider, subscriptionPrompt ?? query, signal)
    : await searchHttp(provider, query, count, signal)
  return { provider, query, ...parsed }
}

export async function testWebSearchKey(provider: HttpProvider, signal: AbortSignal): Promise<void> {
  try {
    if (provider === 'anysearch') {
      await searchHttp('anysearch', 'MintBot', 1, signal)
      return
    }
    const config = getWebSearchConfig()
    const key = provider === 'deepseek' ? config.deepseekApiKey : config.tavilyApiKey
    if (!key) throw missingKey(provider)
    const url = provider === 'deepseek' ? 'https://api.deepseek.com/models' : 'https://api.tavily.com/usage'
    const result = await fetcherFor(provider)(url, { method: 'GET', headers: { Authorization: `Bearer ${key}` } }, signal)
    if (!result.ok) throw fetchFailure(provider, result)
  } catch (err) {
    console.error(`[WebSearch] 测试失败：${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}

export async function webSearch({ query, count, subscriptionPrompt, signal }: WebSearchParams): Promise<WebSearchResult> {
  const { order } = getWebSearchConfig()
  if (order.length === 0) throw new WebSearchError('not_configured', '联网搜索没有启用任何服务，请先在设置里添加')
  if (query.trim() === '') throw new WebSearchError('invalid_query', '搜索词不能为空')

  const failures: string[] = []
  let last: WebSearchError | undefined
  for (const provider of order) {
    if (signal.aborted) throw aborted()
    try {
      return await searchWith(provider, query, count, subscriptionPrompt, signal)
    } catch (err) {
      if (err instanceof WebSearchError && err.kind === 'aborted') throw err
      last = err instanceof WebSearchError
        ? err
        : new WebSearchError('http', `${LABEL[provider]}：${err instanceof Error ? err.message : String(err)}`)
      failures.push(last.message)
      console.error(`[WebSearch] 失败：${last.message}；搜索词：${query}`)
    }
  }
  const final = last as WebSearchError
  if (failures.length > 1) console.error(`[WebSearch] 全部失败：${failures.join('；')}；搜索词：${query}`)
  throw failures.length === 1 ? final : new WebSearchError(final.kind, failures.join('；'))
}
