let lockStartedAt: number | null = null

export function recordSystemEvent(type: 'lock-screen' | 'unlock-screen', at: number = Date.now()): void {
  if (type === 'lock-screen') lockStartedAt = at
  else if (type === 'unlock-screen') lockStartedAt = null
}

export function getLockScreenMinutes(now: number = Date.now()): number {
  return lockStartedAt === null ? 0 : (now - lockStartedAt) / 60_000
}
