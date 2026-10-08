
export const RECONNECT_BACKOFF_FLOOR_MS = 1000

export const RECONNECT_BACKOFF_CAP_MS = 30000

export function nextReconnectDelayMs(previousDelayMs: number): number {
  return Math.min(previousDelayMs * 2, RECONNECT_BACKOFF_CAP_MS)
}
