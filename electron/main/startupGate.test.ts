import { describe, it, expect } from 'vitest'
import { shouldDistrustHomeAtStartup } from './startupGate'

// 只测纯判断——queryUserNotificationState 本身依赖真实 Win32 调用，不在这里测，跟
// activeWindowMonitor.ts 里 getActiveWindowInfo/probeBlockerWindow 不单测、只测
// isFullscreenRect/classifyPidCheck 同一个约定

describe('shouldDistrustHomeAtStartup', () => {
  it('distrusts home on QUNS_BUSY', () => {
    expect(shouldDistrustHomeAtStartup(2)).toBe(true)
  })

  it('distrusts home on QUNS_RUNNING_D3D_FULL_SCREEN', () => {
    expect(shouldDistrustHomeAtStartup(3)).toBe(true)
  })

  it('distrusts home on QUNS_PRESENTATION_MODE', () => {
    expect(shouldDistrustHomeAtStartup(4)).toBe(true)
  })

  it('trusts home on the other documented states', () => {
    expect(shouldDistrustHomeAtStartup(1)).toBe(false) // QUNS_NOT_PRESENT
    expect(shouldDistrustHomeAtStartup(5)).toBe(false) // QUNS_ACCEPTS_NOTIFICATIONS
    expect(shouldDistrustHomeAtStartup(6)).toBe(false) // QUNS_QUIET_TIME
    expect(shouldDistrustHomeAtStartup(7)).toBe(false) // QUNS_APP
  })

  it('trusts home when the query itself failed (null) — never blocks startup on a broken gate', () => {
    expect(shouldDistrustHomeAtStartup(null)).toBe(false)
  })
})
