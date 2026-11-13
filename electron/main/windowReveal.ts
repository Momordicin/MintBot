// electron/main/windowReveal.ts — 聊天窗口与其子窗口每次出现时的透明显示与画好后淡入（按窗口各自等待）；子窗口首次显示等页面就绪
// 用法：index.ts / windowBehavior.ts 显示聊天窗口时调 revealWindow(win, show, onShown?)，收到 chat:painted 时调 notifyWindowPainted(sender)；index.ts 创建子窗口时调 attachChildWindowReveal(win, show)，再次打开时用 isChildWindowRevealPending(win) 判断首次显示是否仍在等待，收到 window:ready / window:painted 时调 notifyChildWindowReady / notifyChildWindowPainted(sender)，向子窗口发 window:shown
// 对应文件：electron/main/index.ts / electron/main/windowBehavior.ts / electron/main/windowAnimation.ts / electron/main/windowReveal.test.ts / src/useWindowReveal.ts
import type { BrowserWindow, WebContents } from 'electron'
import { fadeIn, finishAnimation } from './windowAnimation'

export const WINDOW_REVEAL_TIMEOUT_MS = 1000
export const WINDOW_FADE_IN_MS = 500
export const CHILD_WINDOW_READY_TIMEOUT_MS = 3000

type PendingReveal = { trigger: () => void }

const pendingReveals = new Map<BrowserWindow, PendingReveal>()

export function onceWithTimeout(action: () => void, timeoutMs: number): () => void {
  let done = false
  const trigger = (): void => {
    if (done) return
    done = true
    clearTimeout(timer)
    action()
  }
  const timer = setTimeout(trigger, timeoutMs)
  return trigger
}

export function revealWindow(win: BrowserWindow, show: () => void, onShown?: () => void): void {
  if (win.isDestroyed()) return
  if (win.isVisible() && !win.isMinimized()) {
    show()
    return
  }
  finishAnimation(win)
  win.setOpacity(0)
  show()
  onShown?.()
  const reveal: PendingReveal = { trigger: () => {} }
  reveal.trigger = onceWithTimeout(() => {
    if (pendingReveals.get(win) !== reveal) return
    pendingReveals.delete(win)
    fadeIn(win, WINDOW_FADE_IN_MS)
  }, WINDOW_REVEAL_TIMEOUT_MS)
  pendingReveals.set(win, reveal)
}

export function notifyWindowPainted(sender: WebContents): void {
  for (const [win, reveal] of pendingReveals) {
    if (win.isDestroyed()) {
      pendingReveals.delete(win)
      continue
    }
    if (win.webContents === sender) {
      reveal.trigger()
      return
    }
  }
}

const childWindowReady = new Map<WebContents, () => void>()
const pendingChildWindows = new Set<BrowserWindow>()

export function attachChildWindowReveal(win: BrowserWindow, show: () => void): void {
  const webContents = win.webContents
  let done = false
  const ready = (): void => {
    if (done) return
    done = true
    clearTimeout(timer)
    pendingChildWindows.delete(win)
    revealWindow(win, show, () => webContents.send('window:shown'))
  }
  const timer = setTimeout(ready, CHILD_WINDOW_READY_TIMEOUT_MS)
  childWindowReady.set(webContents, ready)
  pendingChildWindows.add(win)
  win.once('closed', () => {
    done = true
    clearTimeout(timer)
    childWindowReady.delete(webContents)
    pendingChildWindows.delete(win)
  })
}

export function isChildWindowRevealPending(win: BrowserWindow): boolean {
  return pendingChildWindows.has(win)
}

export function notifyChildWindowReady(sender: WebContents): void {
  childWindowReady.get(sender)?.()
}

export function notifyChildWindowPainted(sender: WebContents): void {
  if (childWindowReady.has(sender)) notifyWindowPainted(sender)
}
