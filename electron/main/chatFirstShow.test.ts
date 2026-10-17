import { describe, it, expect } from 'vitest'
import { CHAT_READY_TIMEOUT_MS, shouldShowChatOnFirstReady } from './chatFirstShow'

describe('shouldShowChatOnFirstReady', () => {
  it('shows when the chat was requested during the wait, even after an autostart launch', () => {
    expect(shouldShowChatOnFirstReady(true, false)).toBe(true)
    expect(shouldShowChatOnFirstReady(true, true)).toBe(true)
  })

  it('shows on a normal launch', () => {
    expect(shouldShowChatOnFirstReady(false, false)).toBe(true)
  })

  it('stays hidden on an autostart launch with no pending request', () => {
    expect(shouldShowChatOnFirstReady(false, true)).toBe(false)
  })
})

describe('CHAT_READY_TIMEOUT_MS', () => {
  it('is at most 3 seconds', () => {
    expect(CHAT_READY_TIMEOUT_MS).toBeGreaterThan(0)
    expect(CHAT_READY_TIMEOUT_MS).toBeLessThanOrEqual(3000)
  })
})
