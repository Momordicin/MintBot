let lastActivityAt = Date.now()

export function recordActivity(): void {
  lastActivityAt = Date.now()
}

export function getLastActivityAt(): number {
  return lastActivityAt
}
