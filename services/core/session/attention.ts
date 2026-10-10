// services/core/session/attention.ts — 记录各会话最近一次"被关注"的时间，以及角色是否已明说要睡
// 用法：recordAttention(sessionId)（POST /chat 助手回复后、POST /internal/overlay-interaction 调用）；markExplicitSleep / isExplicitSleep（chat.ts、state.ts）；getLastAttentionAt（state.ts）
// 形状：Map<sessionId, 毫秒时间戳> 与 Set<sessionId>
// 对应文件：services/core/routes/chat.ts / services/core/routes/internal.ts / services/core/state.ts / services/core/session/queries.ts / services/core/session/attention.test.ts
import { getMostRecentMessageTimeForSession } from './queries.js'

const lastAttentionAt = new Map<string, number>()
const explicitSleep = new Set<string>()

export function recordAttention(sessionId: string, at: number = Date.now()): void {
  lastAttentionAt.set(sessionId, at)
  explicitSleep.delete(sessionId)
}

export function getLastAttentionAt(sessionId: string): number | null {
  const cached = lastAttentionAt.get(sessionId)
  if (cached !== undefined) return cached
  return getMostRecentMessageTimeForSession(sessionId)
}

export function markExplicitSleep(sessionId: string): void {
  explicitSleep.add(sessionId)
}

export function isExplicitSleep(sessionId: string): boolean {
  return explicitSleep.has(sessionId)
}
