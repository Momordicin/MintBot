import { describe, it, expect } from 'vitest'
import { shouldSkipOverlayDodge } from './windowBehavior'

// 只测 handleOverlayDodge 的前置守卫（纯函数）。本模块其余部分依赖真实
// BrowserWindow/screen/activeWindowMonitor 轮询状态，需要真实 Electron 运行时才能验证，
// 这里不测——跟 windowAnimation.test.ts 只测纯函数同一个约定

describe('shouldSkipOverlayDodge', () => {
  it('skips when the overlay is hidden and not tracking a dodge', () => {
    expect(shouldSkipOverlayDodge(false, null)).toBe(true)
  })

  it('does not skip when the overlay is visible, regardless of dodge tracking', () => {
    expect(shouldSkipOverlayDodge(true, null)).toBe(false)
    expect(shouldSkipOverlayDodge(true, 3)).toBe(false)
  })

  it('does not skip when hidden but still tracking a parked dodge (single-monitor fallback)', () => {
    expect(shouldSkipOverlayDodge(false, 3)).toBe(false)
  })
})
