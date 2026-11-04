// services/core/tools/subscriptionSearch.ts — 经已登录的 Claude Code 订阅（否则 Codex 订阅）做一次限时联网查询，附带当前本地日期时间
// 用法：tools/webLookup.ts 与 tools/rememberLocation.ts 调 runSubscriptionSearch(prompt, chatSignal) 与 withLocalTime(query)；用到 agents/claudeCode.ts 的 getClaudeLoginStatus / claudeWebSearch 与 agents/codex.ts 的 getCodexLoginStatus / codexWebSearch
// 对应文件：services/core/tools/webLookup.ts / services/core/tools/rememberLocation.ts / services/core/agents/claudeCode.ts / services/core/agents/codex.ts
import { getClaudeLoginStatus, claudeWebSearch } from '../agents/claudeCode.js'
import { getCodexLoginStatus, codexWebSearch } from '../agents/codex.js'

export const SEARCH_TIMEOUT_MS = 180000
export const NOT_LOGGED_IN_MESSAGE = '未登录：请告知用户先在设置的全局模型服务中登录 Claude Code 或 Codex'

export class NotLoggedInError extends Error {
  constructor() {
    super(NOT_LOGGED_IN_MESSAGE)
    this.name = 'NotLoggedInError'
  }
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

export function formatLocalTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  const offset = abs % 60 === 0 ? `${Math.floor(abs / 60)}` : `${Math.floor(abs / 60)}:${pad(abs % 60)}`
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 星期${WEEKDAYS[date.getDay()]} ${pad(date.getHours())}:${pad(date.getMinutes())}（UTC${sign}${offset}）`
}

export function withLocalTime(query: string, now: Date = new Date()): string {
  return `请联网查询，用中文分点列出查询到的事实要点和相关建议，每条一行；不要寒暄，不要写成段落，不要列出查询过程：\n${query}\n当前本地时间：${formatLocalTime(now)}`
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export async function runSubscriptionSearch(prompt: string, chatSignal: AbortSignal): Promise<string> {
  const signal = AbortSignal.any([chatSignal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)])
  let result: { text: string }
  if (await raceAbort(getClaudeLoginStatus(), signal)) {
    result = await claudeWebSearch({ query: prompt, signal })
  } else if (await raceAbort(getCodexLoginStatus(), signal)) {
    result = await codexWebSearch({ query: prompt, signal })
  } else {
    throw new NotLoggedInError()
  }
  const text = result.text.trim()
  if (!text) throw new Error('[SubscriptionSearch] empty result')
  return text
}
