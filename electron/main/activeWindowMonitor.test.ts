import { describe, it, expect } from 'vitest'
import { isFullscreenRect, observationFingerprint, classifyPidCheck, classifyRectProbe } from './activeWindowMonitor'
import type { ExternalWindowInfo, ForegroundObservation } from './activeWindowMonitor'

// 只测本文件里不依赖真实 Win32 调用结果的纯函数——isFullscreenRect/observationFingerprint
// 都只吃调用方给的普通数据。getActiveWindowInfo/probeBlockerWindow 本身依赖真实前台窗口/
// 真实 Win32 句柄，不在这里测，跟 windowBehavior.test.ts「只测纯函数」同一个约定

const DISPLAY_BOUNDS = { x: 0, y: 0, width: 1920, height: 1080 }

describe('isFullscreenRect', () => {
  it('accepts a rect that matches the display exactly, without caption/thickframe styles', () => {
    expect(isFullscreenRect(DISPLAY_BOUNDS, DISPLAY_BOUNDS, 0)).toBe(true)
  })

  it('accepts a borderless-fullscreen window sitting up to 2 DIP off each edge (tolerance)', () => {
    const rect = { x: 1, y: -2, width: 1918, height: 1082 } // right edge at 1919, bottom at 1080
    expect(isFullscreenRect(rect, DISPLAY_BOUNDS, 0)).toBe(true)
  })

  it('rejects a rect more than the 2 DIP tolerance off the display bounds', () => {
    const rect = { x: 3, y: 0, width: 1920, height: 1080 } // left edge off by 3
    expect(isFullscreenRect(rect, DISPLAY_BOUNDS, 0)).toBe(false)
  })

  it('rejects a maximised normal window (rect matches display, but still has WS_CAPTION|WS_THICKFRAME)', () => {
    const WS_CAPTION = 0xc00000
    const WS_THICKFRAME = 0x40000
    expect(isFullscreenRect(DISPLAY_BOUNDS, DISPLAY_BOUNDS, WS_CAPTION | WS_THICKFRAME)).toBe(false)
  })
})

function makeExternalInfo(overrides: Partial<ExternalWindowInfo> = {}): ExternalWindowInfo {
  return {
    hwnd: 1000n,
    pid: 111,
    title: 'Some Window',
    isFullscreen: false,
    exeName: 'game.exe',
    displayId: 1,
    ...overrides,
  }
}

describe('observationFingerprint', () => {
  it('ignores a title-only change on the same window', () => {
    const a: ForegroundObservation = { kind: 'external', info: makeExternalInfo({ title: 'Tab 1 - Browser' }) }
    const b: ForegroundObservation = { kind: 'external', info: makeExternalInfo({ title: 'Tab 2 - Browser' }) }
    expect(observationFingerprint(a)).toBe(observationFingerprint(b))
  })

  it('reacts to an hwnd-only change (same exe/fullscreen/display, different window)', () => {
    const a: ForegroundObservation = { kind: 'external', info: makeExternalInfo({ hwnd: 1000n }) }
    const b: ForegroundObservation = { kind: 'external', info: makeExternalInfo({ hwnd: 2000n }) }
    expect(observationFingerprint(a)).not.toBe(observationFingerprint(b))
  })

  it('distinguishes self and unavailable from each other and from external', () => {
    const self: ForegroundObservation = { kind: 'self' }
    const unavailable: ForegroundObservation = { kind: 'unavailable' }
    const external: ForegroundObservation = { kind: 'external', info: makeExternalInfo() }
    expect(observationFingerprint(self)).not.toBe(observationFingerprint(unavailable))
    expect(observationFingerprint(self)).not.toBe(observationFingerprint(external))
  })
})

// Finding A（Stage 1 review）: probeBlockerWindow itself depends on real Win32 calls and isn't
// unit-tested here (see file header comment), but the pid cross-check it delegates to is a pure
// decision and is the exact boundary the review flagged: a transient resolvePid failure (null)
// must not be indistinguishable from "a different, specific pid was found" (HWND recycled)
describe('classifyPidCheck', () => {
  it('is a probe-error when resolvePid failed to produce any pid (not a pid-mismatch)', () => {
    expect(classifyPidCheck(null, 111)).toBe('probe-error')
  })

  it('is a pid-mismatch when a different, concrete pid was found (HWND recycled)', () => {
    expect(classifyPidCheck(222, 111)).toBe('pid-mismatch')
  })

  it('is a match when the resolved pid equals the expected pid', () => {
    expect(classifyPidCheck(111, 111)).toBe('match')
  })
})

// Fix 6 (rework): a GetWindowRect read failure must not be conflated with "window is gone" —
// by the point probeBlockerWindow calls it, IsWindow and the pid cross-check have already
// passed, so a failed read here is "could not determine", not "confirmed absent" (see
// docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」on evidence-driven clearing).
describe('classifyRectProbe', () => {
  it('is probe-error when GetWindowRect fails, not gone', () => {
    expect(classifyRectProbe(false)).toBe('probe-error')
  })

  it('is ok when GetWindowRect succeeds', () => {
    expect(classifyRectProbe(true)).toBe('ok')
  })
})
