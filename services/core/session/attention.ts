// services/core/session/attention.ts — 记录各会话最近一次"被关注"的时间、最近一次被激活的时间，以及角色是否已明说要睡
// 用法：recordAttention(sessionId)（POST /chat 助手回复后、POST /internal/overlay-interaction 调用）；noteSessionActivated（session/index.ts 的 loadSession）；markExplicitSleep / isExplicitSleep（chat.ts、state.ts）；getLastAttentionAt（state.ts）
// 对应文件：services/core/routes/chat.ts / services/core/routes/internal.ts / services/core/session/index.ts / services/core/state.ts / services/core/session/queries.ts / services/core/session/attention.test.ts
import { getMostRecentMessageTimeForSession } from './queries.js'

const lastAttentionAt = new Map<string, number>()
const explicitSleep = new Set<string>()
const activatedAt = new Map<string, number>()

export function recordAttention(sessionId: string, at: number = Date.now()): void {
  lastAttentionAt.set(sessionId, at)
  explicitSleep.delete(sessionId)
}

export function noteSessionActivated(sessionId: string, at: number = Date.now()): void {
  activatedAt.set(sessionId, at)
}

export function getLastAttentionAt(sessionId: string): number | null {
  const cached = lastAttentionAt.get(sessionId)
  if (cached !== undefined) return cached
  return getMostRecentMessageTimeForSession(sessionId) ?? activatedAt.get(sessionId) ?? null
}

export function markExplicitSleep(sessionId: string): void {
  explicitSleep.add(sessionId)
}

export function isExplicitSleep(sessionId: string): boolean {
  return explicitSleep.has(sessionId)
}
