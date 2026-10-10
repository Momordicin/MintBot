// electron/main/windowDragMonitor.ts — 在 win32 上 hook 窗口的 WM_ENTERSIZEMOVE / WM_EXITSIZEMOVE，回调拖拽开始与结束
// 用法：startWindowDragMonitor(win, onDragStart, onDragEnd) 返回取消 hook 的函数；非 win32 为空操作；index.ts 对 overlay 与聊天窗口各调用一次
// 对应文件：electron/main/index.ts / electron/main/dragActivity.ts（回调里记录拖拽态）
import type { BrowserWindow } from 'electron'

const WM_ENTERSIZEMOVE = 0x0231
const WM_EXITSIZEMOVE = 0x0232

export function startWindowDragMonitor(
  win: BrowserWindow,
  onDragStart: () => void,
  onDragEnd: () => void
): () => void {
  if (process.platform !== 'win32') {
    return () => {}
  }

  win.hookWindowMessage(WM_ENTERSIZEMOVE, () => onDragStart())
  win.hookWindowMessage(WM_EXITSIZEMOVE, () => onDragEnd())

  return () => {
    if (win.isDestroyed()) return
    win.unhookWindowMessage(WM_ENTERSIZEMOVE)
    win.unhookWindowMessage(WM_EXITSIZEMOVE)
  }
}
