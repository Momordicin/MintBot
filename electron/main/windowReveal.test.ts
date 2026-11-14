import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./windowAnimation', () => ({
  fadeIn: vi.fn((win: { setOpacity: (o: number) => void }) => win.setOpacity(1)),
  finishAnimation: vi.fn(),
}))

import {
  CHAT_FADE_START_DELAY_MS,
  CHILD_WINDOW_FADE_START_DELAY_MS,
  CHILD_WINDOW_FIRST_FADE_START_DELAY_MS,
  WINDOW_FADE_IN_MS,
  attachChildWindowReveal,
  cancelChildWindowReveal,
  getPendingChildWindowRequestedAt,
  hideChildWindow,
  isChildWindowRevealPending,
  notifyChildWindowPainted,
  notifyChildWindowReady,
  notifyWindowPainted,
  revealChildWindow,
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
    hide: vi.fn(() => {
      visible = false
    }),
  }
}

type FakeWindow = ReturnType<typeof makeWindow>

function asWindow(win: FakeWindow): Electron.BrowserWindow {
  return win as unknown as Electron.BrowserWindow
}

function asSender(win: FakeWindow): Electron.WebContents {
  return win.webContents as unknown as Electron.WebContents
}

function revealAsChat(win: FakeWindow, requestedAt = Date.now()): void {
  revealWindow(asWindow(win), () => win.show(), {
    label: 'chat',
    requestedAt,
    fadeStartDelayMs: CHAT_FADE_START_DELAY_MS,
    onShown: () => win.webContents.send('chat:shown'),
  })
}

describe('revealWindow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(fadeIn).mockClear()
  })
  afterEach(() => vi.useRealTimers())

  it('shows a hidden window transparent after finishing any running animation, then runs onShown', () => {
    vi.mocked(finishAnimation).mockClear()
    const win = makeWindow({ visible: false })
    revealAsChat(win)

    expect(finishAnimation).toHaveBeenCalledWith(win)
    expect(vi.mocked(finishAnimation).mock.invocationCallOrder[0]).toBeLessThan(win.setOpacity.mock.invocationCallOrder[0])
    expect(win.setOpacity).toHaveBeenCalledWith(0)
    expect(win.setOpacity.mock.invocationCallOrder[0]).toBeLessThan(win.show.mock.invocationCallOrder[0])
    expect(win.webContents.send).toHaveBeenCalledWith('chat:shown')
    expect(win.show.mock.invocationCallOrder[0]).toBeLessThan(win.webContents.send.mock.invocationCallOrder[0])
    expect(fadeIn).not.toHaveBeenCalled()
  })

  it.each([
    ['chat, painted before the deadline', CHAT_FADE_START_DELAY_MS, 100],
    ['chat, painted after the deadline', CHAT_FADE_START_DELAY_MS, CHAT_FADE_START_DELAY_MS + 100],
    ['chat, never painted', CHAT_FADE_START_DELAY_MS, null],
    ['child first open, painted before the deadline', CHILD_WINDOW_FIRST_FADE_START_DELAY_MS, 500],
    ['child first open, never painted', CHILD_WINDOW_FIRST_FADE_START_DELAY_MS, null],
  ])('%s: fades in for WINDOW_FADE_IN_MS exactly at requestedAt + delay', (_label, delayMs, paintedAtMs) => {
    const win = makeWindow({ visible: false })
    const requestedAt = Date.now()
    revealWindow(asWindow(win), () => win.show(), { label: 'chat', requestedAt, fadeStartDelayMs: delayMs })
    if (paintedAtMs !== null && paintedAtMs < delayMs) {
      vi.advanceTimersByTime(paintedAtMs)
      notifyWindowPainted(asSender(win))
      expect(fadeIn).not.toHaveBeenCalled()
    }
    vi.advanceTimersByTime(requestedAt + delayMs - 1 - Date.now())
    expect(fadeIn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fadeIn).toHaveBeenCalledTimes(1)
    expect(fadeIn).toHaveBeenCalledWith(win, 300)
    expect(WINDOW_FADE_IN_MS).toBe(300)
    if (paintedAtMs !== null && paintedAtMs >= delayMs) {
      vi.advanceTimersByTime(paintedAtMs - delayMs)
      notifyWindowPainted(asSender(win))
    }
    vi.advanceTimersByTime(2000)
    expect(fadeIn).toHaveBeenCalledTimes(1)
  })

  it('counts the delay from requestedAt, not from the show call', () => {
    const win = makeWindow({ visible: false })
    const requestedAt = Date.now()
    vi.advanceTimersByTime(150)
    revealAsChat(win, requestedAt)
    vi.advanceTimersByTime(CHAT_FADE_START_DELAY_MS - 150 - 1)
    expect(fadeIn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fadeIn).toHaveBeenCalledTimes(1)
  })

  it('fades in immediately when requestedAt + delay has already passed at show time', () => {
    const win = makeWindow({ visible: false })
    const requestedAt = Date.now()
    vi.advanceTimersByTime(CHAT_FADE_START_DELAY_MS + 50)
    revealAsChat(win, requestedAt)
    expect(fadeIn).toHaveBeenCalledTimes(1)
    expect(fadeIn).toHaveBeenCalledWith(win, WINDOW_FADE_IN_MS)
    expect(vi.getTimerCount()).toBe(0)
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
    vi.advanceTimersByTime(CHAT_FADE_START_DELAY_MS)
    expect(fadeIn).not.toHaveBeenCalled()
  })

  it('a new reveal of the same window replaces the pending one and fades in only at its own deadline', () => {
    const win = makeWindow({ visible: false })
    revealAsChat(win)
    vi.advanceTimersByTime(CHAT_FADE_START_DELAY_MS / 2)
    win.hide()
    revealAsChat(win)
    vi.advanceTimersByTime(CHAT_FADE_START_DELAY_MS / 2)
    expect(fadeIn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(CHAT_FADE_START_DELAY_MS / 2)
    expect(fadeIn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(CHAT_FADE_START_DELAY_MS)
    expect(fadeIn).toHaveBeenCalledTimes(1)
  })

  it('concurrent reveals of different windows each fade in at their own deadline', () => {
    const a = makeWindow({ visible: false })
    const b = makeWindow({ visible: false })
    revealAsChat(a)
    vi.advanceTimersByTime(CHAT_FADE_START_DELAY_MS / 2)
    revealAsChat(b)
    vi.advanceTimersByTime(CHAT_FADE_START_DELAY_MS / 2)
    expect(fadeIn).toHaveBeenCalledTimes(1)
    expect(fadeIn).toHaveBeenLastCalledWith(a, WINDOW_FADE_IN_MS)
    vi.advanceTimersByTime(CHAT_FADE_START_DELAY_MS / 2)
    expect(fadeIn).toHaveBeenCalledTimes(2)
    expect(fadeIn).toHaveBeenLastCalledWith(b, WINDOW_FADE_IN_MS)
  })
})

describe('child window reveal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(fadeIn).mockClear()
  })
  afterEach(() => vi.useRealTimers())

  function attach(win: FakeWindow, requestedAt = Date.now()): void {
    attachChildWindowReveal(asWindow(win), () => win.show(), requestedAt, CHILD_WINDOW_FIRST_FADE_START_DELAY_MS, 'settings')
  }

  it('window:ready before the deadline shows at ready, sends window:shown once, and fades in at the deadline', () => {
    const win = makeWindow({ visible: false })
    attach(win)
    vi.advanceTimersByTime(300)
    expect(win.show).not.toHaveBeenCalled()

    notifyChildWindowReady(asSender(win))
    notifyChildWindowReady(asSender(win))
    expect(win.show).toHaveBeenCalledTimes(1)
    expect(win.setOpacity.mock.invocationCallOrder[0]).toBeLessThan(win.show.mock.invocationCallOrder[0])
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledWith('window:shown')

    notifyChildWindowPainted(asSender(win))
    vi.advanceTimersByTime(CHILD_WINDOW_FIRST_FADE_START_DELAY_MS - 300 - 1)
    expect(fadeIn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fadeIn).toHaveBeenCalledTimes(1)
    expect(fadeIn).toHaveBeenCalledWith(win, WINDOW_FADE_IN_MS)
    win.close()
  })

  it('the deadline before window:ready shows the window and fades in at that moment; a late ready does nothing more', () => {
    const win = makeWindow({ visible: false })
    attach(win)
    vi.advanceTimersByTime(CHILD_WINDOW_FIRST_FADE_START_DELAY_MS - 1)
    expect(win.show).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(win.show).toHaveBeenCalledTimes(1)
    expect(win.setOpacity).toHaveBeenCalledWith(0)
    expect(win.webContents.send).toHaveBeenCalledWith('window:shown')
    expect(fadeIn).toHaveBeenCalledTimes(1)
    notifyChildWindowReady(asSender(win))
    expect(win.show).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    win.close()
  })

  it('does not reveal a window closed before window:ready, and clears its timer', () => {
    const win = makeWindow({ visible: false })
    attach(win)
    win.close()
    expect(vi.getTimerCount()).toBe(0)
    notifyChildWindowReady(asSender(win))
    vi.advanceTimersByTime(CHILD_WINDOW_FIRST_FADE_START_DELAY_MS)
    expect(win.show).not.toHaveBeenCalled()
    expect(win.setOpacity).not.toHaveBeenCalled()
  })

  it.each([
    ['window:ready', (win: FakeWindow) => notifyChildWindowReady(asSender(win))],
    ['the deadline', () => vi.advanceTimersByTime(CHILD_WINDOW_FIRST_FADE_START_DELAY_MS)],
    ['close', (win: FakeWindow) => win.close()],
  ])('reports the first show as pending with its requestedAt from attach until %s', (_label, settle) => {
    const win = makeWindow({ visible: false })
    expect(isChildWindowRevealPending(asWindow(win))).toBe(false)
    expect(getPendingChildWindowRequestedAt(asWindow(win))).toBeUndefined()
    const requestedAt = Date.now() - 100
    attach(win, requestedAt)
    expect(isChildWindowRevealPending(asWindow(win))).toBe(true)
    expect(getPendingChildWindowRequestedAt(asWindow(win))).toBe(requestedAt)
    settle(win)
    expect(isChildWindowRevealPending(asWindow(win))).toBe(false)
    expect(getPendingChildWindowRequestedAt(asWindow(win))).toBeUndefined()
    win.close()
  })

  it('hiding an attached window sends window:hidden; a later reveal shows it transparent, sends window:shown and fades in at the passed delay', () => {
    const win = makeWindow({ visible: false })
    attach(win)
    notifyChildWindowReady(asSender(win))
    vi.advanceTimersByTime(CHILD_WINDOW_FIRST_FADE_START_DELAY_MS)
    vi.mocked(fadeIn).mockClear()
    win.webContents.send.mockClear()
    win.setOpacity.mockClear()

    hideChildWindow(asWindow(win))
    expect(win.hide).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledWith('window:hidden')

    revealChildWindow(asWindow(win), () => win.show(), Date.now(), CHILD_WINDOW_FADE_START_DELAY_MS, 'settings')
    expect(win.setOpacity).toHaveBeenCalledWith(0)
    expect(win.webContents.send).toHaveBeenLastCalledWith('window:shown')
    vi.advanceTimersByTime(CHILD_WINDOW_FADE_START_DELAY_MS - 1)
    expect(fadeIn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fadeIn).toHaveBeenCalledWith(win, WINDOW_FADE_IN_MS)
    win.close()
  })

  it.each([
    ['window:ready', (win: FakeWindow) => notifyChildWindowReady(asSender(win))],
    ['the deadline', () => vi.advanceTimersByTime(CHILD_WINDOW_FIRST_FADE_START_DELAY_MS)],
  ])('re-arming a revealed window makes it pending again and %s reveals it once more with the passed delay', (_label, settle) => {
    const win = makeWindow({ visible: false })
    const once = vi.spyOn(win, 'once')
    attach(win)
    notifyChildWindowReady(asSender(win))
    vi.advanceTimersByTime(CHILD_WINDOW_FIRST_FADE_START_DELAY_MS)
    win.hide()
    vi.mocked(fadeIn).mockClear()
    win.show.mockClear()
    win.webContents.send.mockClear()

    const requestedAt = Date.now()
    attach(win, requestedAt)
    expect(isChildWindowRevealPending(asWindow(win))).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    settle(win)
    expect(isChildWindowRevealPending(asWindow(win))).toBe(false)
    expect(win.show).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledWith('window:shown')
    vi.advanceTimersByTime(requestedAt + CHILD_WINDOW_FIRST_FADE_START_DELAY_MS - Date.now())
    expect(fadeIn).toHaveBeenCalledTimes(1)
    notifyChildWindowReady(asSender(win))
    vi.advanceTimersByTime(CHILD_WINDOW_FIRST_FADE_START_DELAY_MS)
    expect(win.show).toHaveBeenCalledTimes(1)
    expect(fadeIn).toHaveBeenCalledTimes(1)
    expect(once.mock.calls.filter(([event]) => event === 'closed')).toHaveLength(2)
    win.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('re-arming while the first show is still pending replaces its timer and closing clears everything', () => {
    const win = makeWindow({ visible: false })
    attach(win)
    vi.advanceTimersByTime(CHILD_WINDOW_FIRST_FADE_START_DELAY_MS / 2)
    attach(win)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(CHILD_WINDOW_FIRST_FADE_START_DELAY_MS / 2)
    expect(win.show).not.toHaveBeenCalled()
    win.close()
    expect(vi.getTimerCount()).toBe(0)
    expect(isChildWindowRevealPending(asWindow(win))).toBe(false)
  })

  it('re-arming while the shown window still waits for its fade drops the old fade and fades in once at the new deadline', () => {
    const win = makeWindow({ visible: false })
    attach(win)
    vi.advanceTimersByTime(100)
    notifyChildWindowReady(asSender(win))
    expect(win.getOpacity()).toBe(0)
    vi.advanceTimersByTime(200)
    win.hide()
    const requestedAt = Date.now()
    attach(win, requestedAt)
    vi.advanceTimersByTime(CHILD_WINDOW_FIRST_FADE_START_DELAY_MS - 300)
    expect(fadeIn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(requestedAt + CHILD_WINDOW_FIRST_FADE_START_DELAY_MS - 1 - Date.now())
    expect(fadeIn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fadeIn).toHaveBeenCalledTimes(1)
    expect(fadeIn).toHaveBeenCalledWith(win, WINDOW_FADE_IN_MS)
    vi.advanceTimersByTime(CHILD_WINDOW_FIRST_FADE_START_DELAY_MS)
    expect(fadeIn).toHaveBeenCalledTimes(1)
    win.close()
  })

  it('cancelling a pending first show stops both the deadline and window:ready from showing it; a re-arm reveals it again', () => {
    const win = makeWindow({ visible: false })
    attach(win)
    cancelChildWindowReveal(asWindow(win))
    expect(isChildWindowRevealPending(asWindow(win))).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    notifyChildWindowReady(asSender(win))
    vi.advanceTimersByTime(CHILD_WINDOW_FIRST_FADE_START_DELAY_MS)
    expect(win.show).not.toHaveBeenCalled()

    attach(win)
    notifyChildWindowReady(asSender(win))
    expect(win.show).toHaveBeenCalledTimes(1)
    win.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancelling after the window was shown drops its pending fade-in', () => {
    const win = makeWindow({ visible: false })
    attach(win)
    notifyChildWindowReady(asSender(win))
    win.hide()
    cancelChildWindowReveal(asWindow(win))
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(CHILD_WINDOW_FIRST_FADE_START_DELAY_MS)
    expect(fadeIn).not.toHaveBeenCalled()
    win.close()
  })

  it('does not send window:hidden to a window that was not attached', () => {
    const win = makeWindow({ visible: true })
    hideChildWindow(asWindow(win))
    expect(win.hide).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).not.toHaveBeenCalled()
  })
})

describe('painted check', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.useFakeTimers()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
    vi.useRealTimers()
  })

  function revealChat(win: FakeWindow): void {
    revealAsChat(win)
  }

  function revealSettings(win: FakeWindow): void {
    attachChildWindowReveal(asWindow(win), () => win.show(), Date.now(), CHILD_WINDOW_FIRST_FADE_START_DELAY_MS, 'settings')
    notifyChildWindowReady(asSender(win))
  }

  it.each([
    ['chat', revealChat, notifyWindowPainted, CHAT_FADE_START_DELAY_MS],
    ['settings', revealSettings, notifyChildWindowPainted, CHILD_WINDOW_FIRST_FADE_START_DELAY_MS],
  ])('%s: painted at or before fade start logs nothing; painted after logs one warning with the delay; a duplicate logs nothing', (label, reveal, painted, delayMs) => {
    const early = makeWindow({ visible: false })
    reveal(early)
    vi.advanceTimersByTime(delayMs)
    painted(asSender(early))
    expect(warn).not.toHaveBeenCalled()
    early.close()

    const late = makeWindow({ visible: false })
    reveal(late)
    vi.advanceTimersByTime(delayMs + 120)
    painted(asSender(late))
    painted(asSender(late))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(`[WindowReveal] ${label} painted 120ms after its fade started`)
    late.close()
  })

  it.each([
    ['an unknown sender on the chat path', (win: FakeWindow) => notifyWindowPainted(asSender(win))],
    ['an unattached sender on the child path', (win: FakeWindow) => {
      revealAsChat(win)
      vi.advanceTimersByTime(CHAT_FADE_START_DELAY_MS + 100)
      notifyChildWindowPainted(asSender(win))
    }],
    ['a closed window', (win: FakeWindow) => {
      revealAsChat(win)
      vi.advanceTimersByTime(CHAT_FADE_START_DELAY_MS + 100)
      win.close()
      notifyWindowPainted(asSender(win))
    }],
  ])('painted from %s logs nothing', (_label, act) => {
    act(makeWindow({ visible: false }))
    expect(warn).not.toHaveBeenCalled()
  })

  it('a new reveal of the same window resets the record', () => {
    const win = makeWindow({ visible: false })
    revealAsChat(win)
    vi.advanceTimersByTime(CHAT_FADE_START_DELAY_MS + 50)
    notifyWindowPainted(asSender(win))
    expect(warn).toHaveBeenCalledTimes(1)

    win.hide()
    revealAsChat(win)
    notifyWindowPainted(asSender(win))
    expect(warn).toHaveBeenCalledTimes(1)

    win.hide()
    revealAsChat(win)
    vi.advanceTimersByTime(CHAT_FADE_START_DELAY_MS + 30)
    notifyWindowPainted(asSender(win))
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenLastCalledWith('[WindowReveal] chat painted 30ms after its fade started')
    win.close()
  })
})
