// electron/main/windowReveal.ts — 聊天窗口与其子窗口的透明显示、固定延迟淡入、子窗口隐藏与页面画好时刻核对
// 用法：index.ts / windowBehavior.ts 显示聊天窗口时调 revealWindow(win, show, { label, requestedAt, fadeStartDelayMs, onShown })，收到 chat:painted 时调 notifyWindowPainted(sender)；index.ts 创建子窗口及子窗口页面崩溃重载时调 attachChildWindowReveal(win, show, requestedAt, fadeStartDelayMs, label)，子窗口页面崩溃不重载时调 cancelChildWindowReveal(win)，用 isChildWindowRevealPending(win) 判断首次显示是否仍在等待，用 getPendingChildWindowRequestedAt(win) 取等待中首次显示的 requestedAt，再次打开隐藏的子窗口时调 revealChildWindow，隐藏子窗口时调 hideChildWindow，收到 window:ready / window:painted 时调 notifyChildWindowReady / notifyChildWindowPainted(sender)；向子窗口发 window:shown / window:hidden
// 对应文件：electron/main/index.ts / electron/main/windowBehavior.ts / electron/main/windowAnimation.ts / electron/main/windowReveal.test.ts / src/useWindowReveal.ts / src/settings/SettingsApp.tsx
import type { BrowserWindow, WebContents } from 'electron'
import { fadeIn, finishAnimation } from './windowAnimation'

export const WINDOW_FADE_IN_MS = 300
export const CHAT_FADE_START_DELAY_MS = 400
export const CHILD_WINDOW_FIRST_FADE_START_DELAY_MS = 800
export const CHILD_WINDOW_FADE_START_DELAY_MS = 400

export type RevealOptions = {
  label: string
  requestedAt: number
  fadeStartDelayMs: number
  onShown?: () => void
}

const pendingReveals = new Map<BrowserWindow, ReturnType<typeof setTimeout>>()
const revealRecords = new Map<BrowserWindow, { label: string; fadeStartAt: number; painted: boolean }>()

function cancelPendingReveal(win: BrowserWindow): void {
  const timer = pendingReveals.get(win)
  if (timer === undefined) return
  clearTimeout(timer)
  pendingReveals.delete(win)
}

export function revealWindow(win: BrowserWindow, show: () => void, options: RevealOptions): void {
  if (win.isDestroyed()) return
  if (win.isVisible() && !win.isMinimized()) {
    show()
    return
  }
  cancelPendingReveal(win)
  finishAnimation(win)
  win.setOpacity(0)
  show()
  const fadeStartAt = options.requestedAt + options.fadeStartDelayMs
  if (!revealRecords.has(win)) win.once('closed', () => revealRecords.delete(win))
  revealRecords.set(win, { label: options.label, fadeStartAt, painted: false })
  options.onShown?.()
  const remainingMs = fadeStartAt - Date.now()
  if (remainingMs <= 0) {
    fadeIn(win, WINDOW_FADE_IN_MS)
    return
  }
  pendingReveals.set(win, setTimeout(() => {
    pendingReveals.delete(win)
    if (!win.isDestroyed()) fadeIn(win, WINDOW_FADE_IN_MS)
  }, remainingMs))
}

export function notifyWindowPainted(sender: WebContents): void {
  for (const [win, record] of revealRecords) {
    if (record.painted || win.isDestroyed() || win.webContents !== sender) continue
    record.painted = true
    const lateMs = Date.now() - record.fadeStartAt
    if (lateMs > 0) console.warn(`[WindowReveal] ${record.label} painted ${lateMs}ms after its fade started`)
    return
  }
}

const childWindowReady = new Map<WebContents, () => void>()
const pendingChildWindows = new Map<BrowserWindow, number>()
const childWindowSettles = new Map<BrowserWindow, () => void>()

export function revealChildWindow(win: BrowserWindow, show: () => void, requestedAt: number, fadeStartDelayMs: number, label: string): void {
  if (win.isDestroyed()) return
  const webContents = win.webContents
  revealWindow(win, show, { label, requestedAt, fadeStartDelayMs, onShown: () => webContents.send('window:shown') })
}

export function attachChildWindowReveal(win: BrowserWindow, show: () => void, requestedAt: number, fadeStartDelayMs: number, label: string): void {
  const webContents = win.webContents
  const previousSettle = childWindowSettles.get(win)
  previousSettle?.()
  cancelPendingReveal(win)
  let done = false
  const settle = (): void => {
    done = true
    clearTimeout(timer)
    pendingChildWindows.delete(win)
  }
  const ready = (): void => {
    if (done) return
    settle()
    revealChildWindow(win, show, requestedAt, fadeStartDelayMs, label)
  }
  const timer = setTimeout(ready, Math.max(0, requestedAt + fadeStartDelayMs - Date.now()))
  childWindowSettles.set(win, settle)
  childWindowReady.set(webContents, ready)
  pendingChildWindows.set(win, requestedAt)
  if (previousSettle) return
  win.once('closed', () => {
    childWindowSettles.get(win)?.()
    childWindowSettles.delete(win)
    childWindowReady.delete(webContents)
    cancelPendingReveal(win)
  })
}

export function cancelChildWindowReveal(win: BrowserWindow): void {
  childWindowSettles.get(win)?.()
  cancelPendingReveal(win)
}

export function isChildWindowRevealPending(win: BrowserWindow): boolean {
  return pendingChildWindows.has(win)
}

export function getPendingChildWindowRequestedAt(win: BrowserWindow): number | undefined {
  return pendingChildWindows.get(win)
}

export function hideChildWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.hide()
  if (childWindowReady.has(win.webContents)) win.webContents.send('window:hidden')
}

export function notifyChildWindowReady(sender: WebContents): void {
  childWindowReady.get(sender)?.()
}

export function notifyChildWindowPainted(sender: WebContents): void {
  if (childWindowReady.has(sender)) notifyWindowPainted(sender)
}
