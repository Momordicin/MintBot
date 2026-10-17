import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./windowAnimation', () => ({
  fadeIn: vi.fn((win: { setOpacity: (o: number) => void }) => win.setOpacity(1)),
  finishAnimation: vi.fn(),
}))

import { CHAT_FADE_IN_MS, CHAT_REVEAL_TIMEOUT_MS, notifyChatPainted, onceWithTimeout, revealChat } from './chatReveal'
import { fadeIn, finishAnimation } from './windowAnimation'

function makeChatWindow(options: { visible: boolean; minimized?: boolean }) {
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
  }
}

function asWindow(win: ReturnType<typeof makeChatWindow>): Electron.BrowserWindow {
  return win as unknown as Electron.BrowserWindow
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

describe('revealChat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(fadeIn).mockClear()
  })
  afterEach(() => vi.useRealTimers())

  it('shows a hidden window transparent, tells the renderer, and fades in on chat:painted from that window', () => {
    const win = makeChatWindow({ visible: false })
    revealChat(asWindow(win), () => win.show())

    expect(win.setOpacity).toHaveBeenCalledWith(0)
    expect(win.setOpacity.mock.invocationCallOrder[0]).toBeLessThan(win.show.mock.invocationCallOrder[0])
    expect(win.webContents.send).toHaveBeenCalledWith('chat:shown')
    expect(fadeIn).not.toHaveBeenCalled()

    notifyChatPainted({} as Electron.WebContents)
    expect(fadeIn).not.toHaveBeenCalled()

    notifyChatPainted(win.webContents as unknown as Electron.WebContents)
    expect(fadeIn).toHaveBeenCalledWith(win, CHAT_FADE_IN_MS)
    expect(win.getOpacity()).toBe(1)

    vi.advanceTimersByTime(CHAT_REVEAL_TIMEOUT_MS)
    expect(fadeIn).toHaveBeenCalledTimes(1)
  })

  it('finishes any running move or fade before going transparent, so nothing raises opacity before the paint', () => {
    vi.mocked(finishAnimation).mockClear()
    const win = makeChatWindow({ visible: false })
    revealChat(asWindow(win), () => win.show())
    expect(finishAnimation).toHaveBeenCalledWith(win)
    expect(vi.mocked(finishAnimation).mock.invocationCallOrder[0]).toBeLessThan(win.setOpacity.mock.invocationCallOrder[0])
  })

  it('fades in at the timeout when chat:painted never arrives', () => {
    const win = makeChatWindow({ visible: false })
    revealChat(asWindow(win), () => win.show())
    vi.advanceTimersByTime(CHAT_REVEAL_TIMEOUT_MS - 1)
    expect(fadeIn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fadeIn).toHaveBeenCalledTimes(1)
    expect(win.getOpacity()).toBe(1)
  })

  it('reveals a minimized window the same way', () => {
    const win = makeChatWindow({ visible: true, minimized: true })
    revealChat(asWindow(win), () => win.show())
    expect(win.setOpacity).toHaveBeenCalledWith(0)
    expect(win.webContents.send).toHaveBeenCalledWith('chat:shown')
  })

  it('only runs show on a window that is already on screen, without touching opacity', () => {
    const win = makeChatWindow({ visible: true })
    revealChat(asWindow(win), () => win.show())
    expect(win.show).toHaveBeenCalledTimes(1)
    expect(win.setOpacity).not.toHaveBeenCalled()
    expect(win.webContents.send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(CHAT_REVEAL_TIMEOUT_MS)
    expect(fadeIn).not.toHaveBeenCalled()
  })

  it('a superseded reveal does not fade in when its own timer fires', () => {
    const first = makeChatWindow({ visible: false })
    revealChat(asWindow(first), () => first.show())
    vi.advanceTimersByTime(CHAT_REVEAL_TIMEOUT_MS / 2)
    const second = makeChatWindow({ visible: false })
    revealChat(asWindow(second), () => second.show())
    vi.advanceTimersByTime(CHAT_REVEAL_TIMEOUT_MS / 2)
    expect(fadeIn).not.toHaveBeenCalled()
    notifyChatPainted(second.webContents as unknown as Electron.WebContents)
    expect(fadeIn).toHaveBeenCalledTimes(1)
    expect(fadeIn).toHaveBeenCalledWith(second, CHAT_FADE_IN_MS)
  })
})

describe('reveal timing constants', () => {
  it('reveal waits at most 1 second and the fade is visible but under a second', () => {
    expect(CHAT_REVEAL_TIMEOUT_MS).toBeGreaterThan(0)
    expect(CHAT_REVEAL_TIMEOUT_MS).toBeLessThanOrEqual(1000)
    expect(CHAT_FADE_IN_MS).toBeGreaterThan(0)
    expect(CHAT_FADE_IN_MS).toBeLessThan(1000)
  })
})
