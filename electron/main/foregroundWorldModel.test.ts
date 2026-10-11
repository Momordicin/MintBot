import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { selectValidationMode, shouldScheduleObservation } from './foregroundWorldModel'
import { noteDragStart, isWindowDragInProgress, clearDragState } from './dragActivity'
import type { ForegroundObservation } from './activeWindowMonitor'

const hooks = vi.hoisted(() => ({
  getActiveWindowInfo: vi.fn(),
  probeBlockerWindow: vi.fn(),
  startWinEventHooks: vi.fn(),
  stopHook: vi.fn(),
}))

vi.mock('./activeWindowMonitor', () => ({
  getActiveWindowInfo: hooks.getActiveWindowInfo,
  probeBlockerWindow: hooks.probeBlockerWindow,
  observationFingerprint: (o: ForegroundObservation) =>
    o.kind === 'external' ? `external:${o.info.hwnd}:${o.info.isFullscreen}` : o.kind,
}))
vi.mock('./winEventHook', () => ({
  EVENT_SYSTEM_FOREGROUND: 0x0003,
  startWinEventHooks: hooks.startWinEventHooks,
}))
vi.mock('./windowBehavior', () => ({
  getWindowBehaviorRules: () => ({ appRules: [] }),
}))

// 只测本文件里不依赖真实 Win32/定时器状态的纯函数——runValidationPass 本身读
// getActiveWindowInfo()/isWindowDragInProgress('overlay')/模块级 displayStateMap，不在这里测，跟
// windowBehavior.test.ts「只测纯函数」同一个约定

describe('selectValidationMode (Fix 3 — conservative mode armed by the real cause, not just a drag)', () => {
  it('is conservative when MintBot itself is the foreground, even with no drag in progress', () => {
    expect(selectValidationMode(true, false)).toBe('conservative')
  })

  it('is conservative when a user drag is in progress, even when MintBot is not the foreground', () => {
    expect(selectValidationMode(false, true)).toBe('conservative')
  })

  it('is conservative when both conditions hold', () => {
    expect(selectValidationMode(true, true)).toBe('conservative')
  })

  it('is standard when neither condition holds', () => {
    expect(selectValidationMode(false, false)).toBe('standard')
  })

  it('is conservative when forced, even with no self foreground and no drag', () => {
    expect(selectValidationMode(false, false, true)).toBe('conservative')
  })

  it('stays standard when the force flag is explicitly false', () => {
    expect(selectValidationMode(false, false, false)).toBe('standard')
  })
})

describe('runValidationPass composition — only the overlay window drag arms conservative mode', () => {
  it('an overlay-only drag puts selectValidationMode in conservative mode', () => {
    noteDragStart('overlay', 0)
    expect(selectValidationMode(false, isWindowDragInProgress('overlay', 0))).toBe('conservative')
    clearDragState('overlay')
  })

  it('a chat-only drag leaves selectValidationMode in standard mode (chat is foreground then, covered by the self condition)', () => {
    noteDragStart('chat', 0)
    expect(selectValidationMode(false, isWindowDragInProgress('overlay', 0))).toBe('standard')
    clearDragState('chat')
  })
})

describe('startDesktopObservation', () => {
  const FG = 0x0003
  const LOC = 0x800b
  const DESTROY = 0x8001

  type Mod = typeof import('./foregroundWorldModel')
  let mod: Mod
  let onEvent: (event: number, hwnd: bigint) => void
  let onObservation: Mock<(observation: ForegroundObservation) => void>
  let onChanged: Mock<() => void>

  const external = (hwnd: bigint, isFullscreen = true): ForegroundObservation => ({
    kind: 'external',
    info: { hwnd, pid: 9, title: 't', className: 'c', isFullscreen, exeName: 'game.exe', displayId: 1 },
  })
  const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

  beforeEach(async () => {
    vi.resetModules()
    hooks.stopHook.mockClear()
    hooks.getActiveWindowInfo.mockReset()
    hooks.probeBlockerWindow.mockReset()
    hooks.getActiveWindowInfo.mockReturnValue(external(500n))
    hooks.probeBlockerWindow.mockReturnValue({ status: 'ok', displayId: 1, isFullscreen: true })
    hooks.startWinEventHooks.mockImplementation((cb: (event: number, hwnd: bigint) => void) => {
      onEvent = cb
      return hooks.stopHook
    })
    mod = await import('./foregroundWorldModel')
    onObservation = vi.fn<(observation: ForegroundObservation) => void>()
    onChanged = vi.fn<() => void>()
  })

  it('observes synchronously on start and reports the change', () => {
    const stop = mod.startDesktopObservation(onObservation, onChanged)
    expect(onObservation).toHaveBeenCalledTimes(1)
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(mod.getDisplayStateMap().get(1)).toMatchObject({ hwnd: 500n })
    stop()
  })

  it('coalesces several foreground events in one turn into a single pass', async () => {
    const stop = mod.startDesktopObservation(onObservation, onChanged)
    hooks.getActiveWindowInfo.mockClear()
    hooks.getActiveWindowInfo.mockReturnValue(external(600n))
    onEvent(FG, 600n)
    onEvent(FG, 600n)
    onEvent(FG, 600n)
    expect(hooks.getActiveWindowInfo).not.toHaveBeenCalled()
    await flush()
    expect(hooks.getActiveWindowInfo.mock.calls.length).toBe(1)
    expect(onObservation).toHaveBeenCalledTimes(2)
    stop()
  })

  it('schedules a pass for a location change of the observed foreground window without any foreground event', async () => {
    hooks.getActiveWindowInfo.mockReturnValue(external(700n, false))
    const stop = mod.startDesktopObservation(onObservation, onChanged)
    hooks.getActiveWindowInfo.mockClear()
    hooks.getActiveWindowInfo.mockReturnValue(external(700n, true))
    onEvent(LOC, 700n)
    await flush()
    expect(hooks.getActiveWindowInfo).toHaveBeenCalledTimes(1)
    expect(onObservation).toHaveBeenCalledTimes(2)
    stop()
  })

  it('validates with the pass observation: a self foreground is conservative, with a single foreground read', async () => {
    const stop = mod.startDesktopObservation(onObservation, onChanged)
    hooks.getActiveWindowInfo.mockClear()
    hooks.probeBlockerWindow.mockClear()
    hooks.getActiveWindowInfo.mockReturnValue({ kind: 'self' })
    onEvent(FG, 1n)
    await flush()
    expect(hooks.getActiveWindowInfo).toHaveBeenCalledTimes(1)
    expect(mod.getDisplayStateMap().get(1)).toMatchObject({ hwnd: 500n })
    stop()
  })

  describe('requestObservation', () => {
    it('forces one pass that propagates onObservation even with an unchanged fingerprint', async () => {
      const stop = mod.startDesktopObservation(onObservation, onChanged)
      onObservation.mockClear()
      mod.requestObservation({ force: true })
      await flush()
      expect(onObservation).toHaveBeenCalledTimes(1)
      onObservation.mockClear()
      mod.requestObservation()
      await flush()
      expect(onObservation).not.toHaveBeenCalled()
      stop()
    })

    it('coalesces several calls in one turn into a single pass', async () => {
      const stop = mod.startDesktopObservation(onObservation, onChanged)
      hooks.getActiveWindowInfo.mockClear()
      onObservation.mockClear()
      mod.requestObservation({ force: true })
      mod.requestObservation()
      mod.requestObservation({ force: true })
      expect(hooks.getActiveWindowInfo).not.toHaveBeenCalled()
      await flush()
      expect(hooks.getActiveWindowInfo).toHaveBeenCalledTimes(1)
      expect(onObservation).toHaveBeenCalledTimes(1)
      stop()
    })

    it('is a no-op when not observing and after stop', async () => {
      mod.requestObservation({ force: true })
      await flush()
      expect(hooks.getActiveWindowInfo).not.toHaveBeenCalled()
      const stop = mod.startDesktopObservation(onObservation, onChanged)
      stop()
      hooks.getActiveWindowInfo.mockClear()
      onObservation.mockClear()
      mod.requestObservation({ force: true })
      await flush()
      expect(hooks.getActiveWindowInfo).not.toHaveBeenCalled()
      expect(onObservation).not.toHaveBeenCalled()
    })
  })

  describe('exception safety', () => {
    it('a throwing forced start pass unhooks, rethrows, and a later start works', () => {
      hooks.getActiveWindowInfo.mockImplementationOnce(() => {
        throw new Error('boom')
      })
      expect(() => mod.startDesktopObservation(onObservation, onChanged)).toThrow('boom')
      expect(hooks.stopHook).toHaveBeenCalledTimes(1)
      mod.requestObservation({ force: true })
      expect(hooks.getActiveWindowInfo).toHaveBeenCalledTimes(1)
      const stop = mod.startDesktopObservation(onObservation, onChanged)
      expect(onObservation).toHaveBeenCalledTimes(1)
      stop()
    })

    it('a throw inside a scheduled pass is logged and a later event still runs a pass', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const stop = mod.startDesktopObservation(onObservation, onChanged)
      hooks.getActiveWindowInfo.mockImplementationOnce(() => {
        throw new Error('boom')
      })
      onEvent(FG, 600n)
      await flush()
      expect(errorSpy).toHaveBeenCalledWith('[DesktopObservation] observation pass failed:', expect.any(Error))
      onObservation.mockClear()
      hooks.getActiveWindowInfo.mockReturnValue(external(600n))
      onEvent(FG, 600n)
      await flush()
      expect(onObservation).toHaveBeenCalledTimes(1)
      stop()
      errorSpy.mockRestore()
    })
  })

  it('ignores location changes of windows that are neither foreground nor a blocker', async () => {
    const stop = mod.startDesktopObservation(onObservation, onChanged)
    hooks.getActiveWindowInfo.mockClear()
    onEvent(LOC, 12345n)
    await flush()
    expect(hooks.getActiveWindowInfo).not.toHaveBeenCalled()
    stop()
  })

  it('clears a blocker whose window was destroyed and reports the change', async () => {
    const stop = mod.startDesktopObservation(onObservation, onChanged)
    expect(mod.getDisplayStateMap().size).toBe(1)
    onChanged.mockClear()
    hooks.getActiveWindowInfo.mockReturnValue({ kind: 'unavailable' })
    hooks.probeBlockerWindow.mockReturnValue({ status: 'gone' })
    onEvent(DESTROY, 500n)
    await flush()
    expect(mod.getDisplayStateMap().size).toBe(0)
    expect(onChanged).toHaveBeenCalledTimes(1)
    stop()
  })

  it('does not report a change when fingerprint and blocker map are unchanged', async () => {
    const stop = mod.startDesktopObservation(onObservation, onChanged)
    onChanged.mockClear()
    onObservation.mockClear()
    onEvent(FG, 500n)
    await flush()
    expect(onObservation).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
    stop()
  })

  it('stop cancels a pending pass and unhooks', async () => {
    const stop = mod.startDesktopObservation(onObservation, onChanged)
    hooks.getActiveWindowInfo.mockClear()
    onEvent(FG, 600n)
    stop()
    await flush()
    expect(hooks.getActiveWindowInfo).not.toHaveBeenCalled()
    expect(hooks.stopHook).toHaveBeenCalledTimes(1)
    stop()
    expect(hooks.stopHook).toHaveBeenCalledTimes(1)
  })

  it('re-propagates after stop then start even with the same fingerprint', () => {
    mod.startDesktopObservation(onObservation, onChanged)()
    onObservation.mockClear()
    const stop = mod.startDesktopObservation(onObservation, onChanged)
    expect(onObservation).toHaveBeenCalledTimes(1)
    stop()
  })
})

describe('shouldScheduleObservation', () => {
  const blockers = new Set<bigint>([7n])

  it('always schedules for a foreground event', () => {
    expect(shouldScheduleObservation(0x0003, 1n, null, new Set())).toBe(true)
  })

  it('schedules other events only for the foreground window or a known blocker', () => {
    expect(shouldScheduleObservation(0x800b, 5n, 5n, blockers)).toBe(true)
    expect(shouldScheduleObservation(0x800b, 7n, 5n, blockers)).toBe(true)
    expect(shouldScheduleObservation(0x800b, 9n, 5n, blockers)).toBe(false)
    expect(shouldScheduleObservation(0x8001, 9n, null, new Set())).toBe(false)
  })
})
