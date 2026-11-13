// electron/main/windowReveal.ts — 聊天窗口与设置窗口每次出现时的透明显示与画好后淡入（按窗口各自等待）
// 用法：index.ts / windowBehavior.ts 显示窗口时调 revealWindow(win, show, onShown?)；index.ts 收到 chat:painted / settings:painted 时调 notifyWindowPainted(sender)
// 对应文件：electron/main/index.ts / electron/main/windowBehavior.ts / electron/main/windowAnimation.ts / electron/main/windowReveal.test.ts
import type { BrowserWindow, WebContents } from 'electron'
import { fadeIn, finishAnimation } from './windowAnimation'

export const WINDOW_REVEAL_TIMEOUT_MS = 1000
export const WINDOW_FADE_IN_MS = 500

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
