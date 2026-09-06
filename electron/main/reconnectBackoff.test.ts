import { describe, it, expect } from 'vitest'
import { nextReconnectDelayMs, RECONNECT_BACKOFF_FLOOR_MS, RECONNECT_BACKOFF_CAP_MS } from './reconnectBackoff'

describe('nextReconnectDelayMs', () => {
  it('doubles the previous delay', () => {
    expect(nextReconnectDelayMs(RECONNECT_BACKOFF_FLOOR_MS)).toBe(RECONNECT_BACKOFF_FLOOR_MS * 2)
    expect(nextReconnectDelayMs(4000)).toBe(8000)
  })

  it('caps growth at RECONNECT_BACKOFF_CAP_MS', () => {
    expect(nextReconnectDelayMs(RECONNECT_BACKOFF_CAP_MS)).toBe(RECONNECT_BACKOFF_CAP_MS)
    expect(nextReconnectDelayMs(RECONNECT_BACKOFF_CAP_MS / 2 + 1)).toBe(RECONNECT_BACKOFF_CAP_MS)
  })

  it('never exceeds the cap even from a value already above it', () => {
    expect(nextReconnectDelayMs(RECONNECT_BACKOFF_CAP_MS * 10)).toBe(RECONNECT_BACKOFF_CAP_MS)
  })
})
