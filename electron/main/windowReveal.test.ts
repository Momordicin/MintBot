import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./windowAnimation', () => ({
  fadeIn: vi.fn((win: { setOpacity: (o: number) => void }) => win.setOpacity(1)),
  finishAnimation: vi.fn(),
}))

import { WINDOW_FADE_IN_MS, WINDOW_REVEAL_TIMEOUT_MS, notifyWindowPainted, onceWithTimeout, revealWindow } from './windowReveal'
import { fadeIn, finishAnimation } from './windowAnimation'

function makeWindow(options: { visible: boolean; minimized?: boolean }) {
  let visible = options.visible
  let minimized = options.minimized ?? false
  let opacity = 1
  const webContents = { send: vi.fn() }
  return {
    webContents,
    isDestroyed: () => false,
    isVisible: () => visible,
    isMinimized: () => minimized,
    getOpacity: () => opacity,
    setOpacity: vi.fn((o: number) => {
      opacity = o
    }),
    show: vi.fn(() => {
      visible = true
      minimized = false
    }),
    hide: () => {
      visible = false
    },
  }
}

function asWindow(win: ReturnType<typeof makeWindow>): Electron.BrowserWindow {
  return win as unknown as Electron.BrowserWindow
}

function asSender(win: ReturnType<typeof makeWindow>): Electron.WebContents {
  return win.webContents as unknown as Electron.WebContents
}

function revealAsChat(win: ReturnType<typeof makeWindow>): void {
  revealWindow(asWindow(win), () => win.show(), () => win.webContents.send('chat:shown'))
}

describe('onceWithTimeout', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs the action once when triggered before the timeout', () => {
    const action = vi.fn()
    const trigger = onceWithTimeout(action, 1000)
    trigger()
    trigger()
    vi.advanceTimersByTime(1000)
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('runs the action at the timeout when never triggered, and not again on a late trigger', () => {
    const action = vi.fn()
    const trigger = onceWithTimeout(action, 1000)
    vi.advanceTimersByTime(999)
    expect(action).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(action).toHaveBeenCalledTimes(1)
    trigger()
    expect(action).toHaveBeenCalledTimes(1)
  })
})

describe('revealWindow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(fadeIn).mockClear()
  })
  afterEach(() => vi.useRealTimers())

  it('shows a hidden window transparent, runs onShown, and fades in on the painted signal from that window', () => {
    const win = makeWindow({ visible: false })
    revealAsChat(win)

    expect(win.setOpacity).toHaveBeenCalledWith(0)
    expect(win.setOpacity.mock.invocationCallOrder[0]).toBeLessThan(win.show.mock.invocationCallOrder[0])
    expect(win.webContents.send).toHaveBeenCalledWith('chat:shown')
    expect(win.show.mock.invocationCallOrder[0]).toBeLessThan(win.webContents.send.mock.invocationCallOrder[0])
    expect(fadeIn).not.toHaveBeenCalled()

    notifyWindowPainted({} as Electron.WebContents)
    expect(fadeIn).not.toHaveBeenCalled()

    notifyWindowPainted(asSender(win))
    expect(fadeIn).toHaveBeenCalledWith(win, WINDOW_FADE_IN_MS)
    expect(win.getOpacity()).toBe(1)

    vi.advanceTimersByTime(WINDOW_REVEAL_TIMEOUT_MS)
    expect(fadeIn).toHaveBeenCalledTimes(1)
  })

  it('finishes any running move or fade before going transparent, so nothing raises opacity before the paint', () => {
    vi.mocked(finishAnimation).mockClear()
    const win = makeWindow({ visible: false })
    revealWindow(asWindow(win), () => win.show())
    expect(finishAnimation).toHaveBeenCalledWith(win)
    expect(vi.mocked(finishAnimation).mock.invocationCallOrder[0]).toBeLessThan(win.setOpacity.mock.invocationCallOrder[0])
  })

  it('fades in at the timeout when the painted signal never arrives', () => {
    const win = makeWindow({ visible: false })
    revealWindow(asWindow(win), () => win.show())
    vi.advanceTimersByTime(WINDOW_REVEAL_TIMEOUT_MS - 1)
    expect(fadeIn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fadeIn).toHaveBeenCalledTimes(1)
    expect(win.getOpacity()).toBe(1)
  })

  it('reveals a minimized window the same way', () => {
    const win = makeWindow({ visible: true, minimized: true })
    revealAsChat(win)
    expect(win.setOpacity).toHaveBeenCalledWith(0)
    expect(win.webContents.send).toHaveBeenCalledWith('chat:shown')
  })

  it('only runs show on a window that is already on screen, without touching opacity or running onShown', () => {
    const win = makeWindow({ visible: true })
    revealAsChat(win)
    expect(win.show).toHaveBeenCalledTimes(1)
    expect(win.setOpacity).not.toHaveBeenCalled()
    expect(win.webContents.send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(WINDOW_REVEAL_TIMEOUT_MS)
    expect(fadeIn).not.toHaveBeenCalled()
  })

  it('a superseded reveal of the same window does not fade in when its own timer fires', () => {
    const win = makeWindow({ visible: false })
    revealAsChat(win)
    vi.advanceTimersByTime(WINDOW_REVEAL_TIMEOUT_MS / 2)
    win.hide()
    revealAsChat(win)
    vi.advanceTimersByTime(WINDOW_REVEAL_TIMEOUT_MS / 2)
    expect(fadeIn).not.toHaveBeenCalled()
    notifyWindowPainted(asSender(win))
    expect(fadeIn).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['painted signals', (a: ReturnType<typeof makeWindow>, b: ReturnType<typeof makeWindow>) => {
      notifyWindowPainted(asSender(a))
      expect(fadeIn).toHaveBeenCalledTimes(1)
      expect(fadeIn).toHaveBeenLastCalledWith(a, WINDOW_FADE_IN_MS)
      notifyWindowPainted(asSender(b))
    }],
    ['timeouts', (a: ReturnType<typeof makeWindow>) => {
      vi.advanceTimersByTime(WINDOW_REVEAL_TIMEOUT_MS / 2)
      expect(fadeIn).toHaveBeenCalledTimes(1)
      expect(fadeIn).toHaveBeenLastCalledWith(a, WINDOW_FADE_IN_MS)
    }],
  ])('concurrent reveals of different windows each fade in on their own %s', (_label, settle) => {
    const a = makeWindow({ visible: false })
    const b = makeWindow({ visible: false })
    revealWindow(asWindow(a), () => a.show())
    vi.advanceTimersByTime(WINDOW_REVEAL_TIMEOUT_MS / 2)
    revealWindow(asWindow(b), () => b.show())
    settle(a, b)
    vi.advanceTimersByTime(WINDOW_REVEAL_TIMEOUT_MS)
    expect(fadeIn).toHaveBeenCalledTimes(2)
    expect(fadeIn).toHaveBeenCalledWith(a, WINDOW_FADE_IN_MS)
    expect(fadeIn).toHaveBeenCalledWith(b, WINDOW_FADE_IN_MS)
  })
})
