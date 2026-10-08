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
