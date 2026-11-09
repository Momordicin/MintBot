// services/core/plugins/pluginFetch.ts — 按插件声明的标准值提供 ctx.fetch：每个插件一个 undici Agent，带重试与时限
// 用法：manager.ts 在插件启用时调 createPluginFetch(metadata.standard)，把返回的函数留给阶段 3 组装 ToolContext；返回形状与 mintbot-weather 的 FetchResult 一致；search/webSearch.ts 为每家搜索各建一个实例，init 带 method / body 时发 POST
// 对应文件：services/core/plugins/package.ts / services/core/plugins/manager.ts / services/core/plugins/plugins.test.ts / services/core/search/webSearch.ts
import { Agent, fetch as undiciFetch } from 'undici'
import type { PluginStandard } from './package.js'

export type FetchResult =
  | { ok: true; status: number; body: string }
  | { ok: false; kind: 'http' | 'timeout' | 'connect' | 'aborted'; status?: number; code?: string; message: string }

export type PluginFetchStandard = Pick<PluginStandard, 'retries' | 'retry_delay_ms' | 'request_timeout_ms' | 'connect_attempt_timeout_ms'>

export type PluginFetch = (
  url: string,
  init: { headers?: Record<string, string>; method?: 'GET' | 'POST'; body?: string } | undefined,
  signal: AbortSignal
) => Promise<FetchResult>

function retryable(result: FetchResult): boolean {
  if (result.ok) return false
  if (result.kind === 'aborted') return false
  if (result.kind === 'http') return result.status === 429 || (result.status ?? 0) >= 500
  return true
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done)
  })
}

export function createPluginFetch(standard: PluginFetchStandard): PluginFetch {
  const dispatcher = new Agent({
    connect: { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: standard.connect_attempt_timeout_ms },
  })

  async function attempt(url: string, init: Parameters<PluginFetch>[1], signal: AbortSignal): Promise<FetchResult> {
    const timeout = AbortSignal.timeout(standard.request_timeout_ms)
    try {
      const response = await undiciFetch(url, { headers: init?.headers, method: init?.method, body: init?.body, dispatcher, signal: AbortSignal.any([signal, timeout]) })
      const body = await response.text()
      if (response.ok) return { ok: true, status: response.status, body }
      return { ok: false, kind: 'http', status: response.status, message: body.slice(0, 200) }
    } catch (err) {
      if (signal.aborted) return { ok: false, kind: 'aborted', message: '调用已中止' }
      if (timeout.aborted) return { ok: false, kind: 'timeout', message: `超过 ${standard.request_timeout_ms} 毫秒` }
      const error = err as Error & { cause?: { code?: string } }
      return { ok: false, kind: 'connect', code: error.cause?.code, message: error.message }
    }
  }

  return async (url, init, signal) => {
    let result = await attempt(url, init, signal)
    for (let i = 0; i < standard.retries && retryable(result); i++) {
      await wait(standard.retry_delay_ms, signal)
      if (signal.aborted) return { ok: false, kind: 'aborted', message: '调用已中止' }
      result = await attempt(url, init, signal)
    }
    return result
  }
}
