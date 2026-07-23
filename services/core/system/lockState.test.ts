import { describe, it, expect } from 'vitest'
import { recordSystemEvent, getLockScreenMinutes } from './lockState.js'

describe('lockState', () => {
  it('未锁屏时 getLockScreenMinutes 默认返回 0', () => {
    expect(getLockScreenMinutes()).toBe(0)
  })

  it('recordSystemEvent(lock-screen, t) 之后 getLockScreenMinutes(t + N分钟) 等于 N', () => {
    const t = 1_000_000
    recordSystemEvent('lock-screen', t)
    expect(getLockScreenMinutes(t + 5 * 60_000)).toBe(5)
    expect(getLockScreenMinutes(t + 90 * 60_000)).toBe(90)
  })

  it('recordSystemEvent(unlock-screen) 之后 getLockScreenMinutes 回到 0', () => {
    recordSystemEvent('lock-screen', 1_000_000)
    recordSystemEvent('unlock-screen')
    expect(getLockScreenMinutes(2_000_000)).toBe(0)
  })
})
