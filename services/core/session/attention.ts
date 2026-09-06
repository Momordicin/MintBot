import { getMostRecentMessageTimeForSession } from './queries.js'

// 上次"搭理 bot"的时刻 + 显式睡着标记（TDD §3.7 附「悬浮窗立绘状态模型」「状态存放」）：
// 两者都只活在核心服务内存里，按 sessionId 索引，从不落库——已知边界见 TDD 原文「已知边界」
// （核心服务重启后丢失，回落到按时长派生，即"说过困了的角色重启后是醒着的"）
const lastAttentionAt = new Map<string, number>()
const explicitSleep = new Set<string>()

// 三种"搭理 bot"交互之一。聊天那一条的判据是**本轮拿到了可用回复**，不是点击发送那一刻
// （TDD §3.7 附「「搭理 bot」的三种交互」下方的已决策说明）——权威调用点在 chat.ts，那里
// 还有一条必须保住的顺序约束：本函数会清除显式睡着标记，所以必须排在困意检测之前。
// 悬浮窗侧的点击小人/
// 拖拽结束上报另有交互上报端点消费，同样会调这个函数。刷新时刻的同时清除显式睡着标记——
// 搭理即视为已醒，与 TDD「刷新『上次搭理时刻』只影响由该时刻派生出的值」一致
export function recordAttention(sessionId: string, at: number = Date.now()): void {
  lastAttentionAt.set(sessionId, at)
  explicitSleep.delete(sessionId)
}

// 内存里没有记录时（核心服务刚启动、或该 session 还从未被"搭理"过），回退读该 session
// 最近一条消息的 createdAt 作为初值（TDD「初值取该 session 最近一条消息的 createdAt」）。
// 故意不缓存这次读回来的值——直接读穿透，没有缓存失效问题
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
