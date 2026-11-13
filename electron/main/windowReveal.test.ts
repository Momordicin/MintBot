import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./windowAnimation', () => ({
  fadeIn: vi.fn((win: { setOpacity: (o: number) => void }) => win.setOpacity(1)),
  finishAnimation: vi.fn(),
}))

import {
  CHILD_WINDOW_READY_TIMEOUT_MS,
  WINDOW_FADE_IN_MS,
  WINDOW_REVEAL_TIMEOUT_MS,
  attachChildWindowReveal,
  isChildWindowRevealPending,
  notifyChildWindowPainted,
  notifyChildWindowReady,
  notifyWindowPainted,
  onceWithTimeout,
  revealWindow,
} from './windowReveal'
import { fadeIn, finishAnimation } from './windowAnimation'

function makeWindow(options: { visible: boolean; minimized?: boolean }) {
  let visible = options.visible
  let minimized = options.minimized ?? false
  let opacity = 1
  let destroyed = false
  const closedListeners: Array<() => void> = []
  const webContents = { send: vi.fn() }
  return {
    webContents,
    isDestroyed: () => destroyed,
    once: (event: string, listener: () => void) => {
      if (event === 'closed') closedListeners.push(listener)
    },
    close: () => {
      destroyed = true
      for (const listener of closedListeners) listener()
    },
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

describe('attachChildWindowReveal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(fadeIn).mockClear()
  })
  afterEach(() => vi.useRealTimers())

  it('reveals once on window:ready, sends window:shown, and fades in on window:painted from that window', () => {
    const win = makeWindow({ visible: false })
    attachChildWindowReveal(asWindow(win), () => win.show())
    expect(win.show).not.toHaveBeenCalled()

    notifyChildWindowReady(asSender(win))
    notifyChildWindowReady(asSender(win))
    expect(win.show).toHaveBeenCalledTimes(1)
    expect(win.setOpacity.mock.invocationCallOrder[0]).toBeLessThan(win.show.mock.invocationCallOrder[0])
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledWith('window:shown')

    notifyChildWindowPainted(asSender(win))
    expect(fadeIn).toHaveBeenCalledWith(win, WINDOW_FADE_IN_MS)
    vi.advanceTimersByTime(CHILD_WINDOW_READY_TIMEOUT_MS)
    expect(win.show).toHaveBeenCalledTimes(1)
    expect(fadeIn).toHaveBeenCalledTimes(1)
    win.close()
  })

  it('reveals at the timeout when window:ready never arrives, and a late ready does nothing more', () => {
    const win = makeWindow({ visible: false })
    attachChildWindowReveal(asWindow(win), () => win.show())
    vi.advanceTimersByTime(CHILD_WINDOW_READY_TIMEOUT_MS - 1)
    expect(win.show).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(win.show).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledWith('window:shown')
    win.hide()
    notifyChildWindowReady(asSender(win))
    expect(win.show).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    win.close()
  })

  it('does not reveal a window closed before window:ready, and clears its timer', () => {
    const win = makeWindow({ visible: false })
    attachChildWindowReveal(asWindow(win), () => win.show())
    win.close()
    expect(vi.getTimerCount()).toBe(0)
    notifyChildWindowReady(asSender(win))
    vi.advanceTimersByTime(CHILD_WINDOW_READY_TIMEOUT_MS)
    expect(win.show).not.toHaveBeenCalled()
    expect(win.setOpacity).not.toHaveBeenCalled()
  })

  it.each([
    ['window:ready', (win: ReturnType<typeof makeWindow>) => notifyChildWindowReady(asSender(win))],
    ['the timeout', () => vi.advanceTimersByTime(CHILD_WINDOW_READY_TIMEOUT_MS)],
    ['close', (win: ReturnType<typeof makeWindow>) => win.close()],
  ])('reports the first show as pending from attach until %s', (_label, settle) => {
    const win = makeWindow({ visible: false })
    expect(isChildWindowRevealPending(asWindow(win))).toBe(false)
    attachChildWindowReveal(asWindow(win), () => win.show())
    expect(isChildWindowRevealPending(asWindow(win))).toBe(true)
    settle(win)
    expect(isChildWindowRevealPending(asWindow(win))).toBe(false)
    win.close()
  })

  it('ignores window:painted from a window that was not attached', () => {
    const chat = makeWindow({ visible: false })
    revealAsChat(chat)
    notifyChildWindowPainted(asSender(chat))
    expect(fadeIn).not.toHaveBeenCalled()
  })
})
