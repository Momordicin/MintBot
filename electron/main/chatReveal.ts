// electron/main/chatReveal.ts — 聊天窗口每次被唤起时的透明显示与画好后淡入
// 用法：index.ts / windowBehavior.ts 显示聊天窗口时调 revealChat(win, show)；index.ts 收到 chat:painted 时调 notifyChatPainted(sender)
// 对应文件：electron/main/index.ts / electron/main/windowBehavior.ts / electron/main/windowAnimation.ts / electron/main/chatReveal.test.ts
import type { BrowserWindow, WebContents } from 'electron'
import { fadeIn, finishAnimation } from './windowAnimation'

export const CHAT_REVEAL_TIMEOUT_MS = 1000
export const CHAT_FADE_IN_MS = 500

type PendingReveal = { win: BrowserWindow; trigger: () => void }

let pendingReveal: PendingReveal | null = null

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

export function revealChat(win: BrowserWindow, show: () => void): void {
  if (win.isDestroyed()) return
  if (win.isVisible() && !win.isMinimized()) {
    show()
    return
  }
  finishAnimation(win)
  win.setOpacity(0)
  show()
  win.webContents.send('chat:shown')
  const reveal: PendingReveal = { win, trigger: () => {} }
  reveal.trigger = onceWithTimeout(() => {
    if (pendingReveal !== reveal) return
    pendingReveal = null
    fadeIn(win, CHAT_FADE_IN_MS)
  }, CHAT_REVEAL_TIMEOUT_MS)
  pendingReveal = reveal
}

export function notifyChatPainted(sender: WebContents): void {
  if (!pendingReveal || pendingReveal.win.isDestroyed()) return
  if (pendingReveal.win.webContents === sender) pendingReveal.trigger()
}
