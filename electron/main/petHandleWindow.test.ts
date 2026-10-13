import { describe, it, expect, vi, beforeEach } from 'vitest'

// 只测 petHandleWindow.ts 对 BrowserWindow / screen 的调用参数与守卫；真实窗口行为（子窗口跟随、
// 置顶继承）需要真实 Electron，不在这里测

const mocks = vi.hoisted(() => ({
  constructed: [] as Array<{ options: Record<string, unknown>; setShape: ReturnType<typeof vi.fn> }>,
  matchDisplay: vi.fn(),
}))

vi.mock('electron', () => ({
  screen: { getDisplayMatching: mocks.matchDisplay },
  BrowserWindow: class {
    setShape = vi.fn()
    constructor(public options: Record<string, unknown>) {
      mocks.constructed.push(this)
    }
  },
}))

import { createPetHandleWindow, syncPetHandleBounds, setPetHandleVisible } from './petHandleWindow'
import { COLLAPSED_SIZE, petHandleBounds } from './windowPositions'

function asWindow(win: unknown): Electron.BrowserWindow {
  return win as Electron.BrowserWindow
}

beforeEach(() => {
  mocks.constructed.length = 0
  mocks.matchDisplay.mockReset()
})

describe('createPetHandleWindow', () => {
  it('creates a non-focusable transparent child window of the overlay and clips it to the handle square', () => {
    const overlay = { id: 'overlay' }
    createPetHandleWindow(asWindow(overlay), '/preload/index.cjs')

    const created = mocks.constructed[0]
    expect(created.options).toMatchObject({
      parent: overlay,
      width: COLLAPSED_SIZE,
      height: COLLAPSED_SIZE,
      frame: false,
      transparent: true,
      alwaysOnTop: false,
      focusable: false,
      show: false,
      webPreferences: { preload: '/preload/index.cjs' },
    })
    expect(created.setShape).toHaveBeenCalledWith([{ x: 0, y: 0, width: COLLAPSED_SIZE, height: COLLAPSED_SIZE }])
  })
})

describe('syncPetHandleBounds', () => {
  const petBounds = { x: 1500, y: 600, width: 132, height: 132 }
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 }

  function makeOverlay(destroyed = false) {
    return { isDestroyed: () => destroyed, getBounds: vi.fn(() => petBounds) }
  }

  it('sets the handle bounds derived from the overlay bounds and its display work area', () => {
    mocks.matchDisplay.mockReturnValue({ workArea })
    const handle = { isDestroyed: () => false, setBounds: vi.fn() }

    syncPetHandleBounds(asWindow(handle), asWindow(makeOverlay()))

    expect(mocks.matchDisplay).toHaveBeenCalledWith(petBounds)
    expect(handle.setBounds).toHaveBeenCalledWith(petHandleBounds(petBounds, workArea))
  })

  it('does nothing when the handle is destroyed', () => {
    const handle = { isDestroyed: () => true, setBounds: vi.fn() }
    syncPetHandleBounds(asWindow(handle), asWindow(makeOverlay()))
    expect(handle.setBounds).not.toHaveBeenCalled()
  })

  it('does nothing when the overlay is destroyed', () => {
    const handle = { isDestroyed: () => false, setBounds: vi.fn() }
    syncPetHandleBounds(asWindow(handle), asWindow(makeOverlay(true)))
    expect(handle.setBounds).not.toHaveBeenCalled()
  })
})

describe('setPetHandleVisible', () => {
  function makeHandle(visible: boolean, destroyed = false) {
    return { isDestroyed: () => destroyed, isVisible: () => visible, showInactive: vi.fn(), hide: vi.fn() }
  }

  it('shows an invisible handle and ignores a repeated show', () => {
    const hidden = makeHandle(false)
    setPetHandleVisible(asWindow(hidden), true)
    expect(hidden.showInactive).toHaveBeenCalledTimes(1)

    const shown = makeHandle(true)
    setPetHandleVisible(asWindow(shown), true)
    expect(shown.showInactive).not.toHaveBeenCalled()
  })

  it('hides a visible handle and ignores a repeated hide', () => {
    const shown = makeHandle(true)
    setPetHandleVisible(asWindow(shown), false)
    expect(shown.hide).toHaveBeenCalledTimes(1)

    const hidden = makeHandle(false)
    setPetHandleVisible(asWindow(hidden), false)
    expect(hidden.hide).not.toHaveBeenCalled()
  })

  it('does nothing when the handle is destroyed', () => {
    const destroyed = makeHandle(false, true)
    setPetHandleVisible(asWindow(destroyed), true)
    expect(destroyed.showInactive).not.toHaveBeenCalled()
    expect(destroyed.hide).not.toHaveBeenCalled()
  })
})
