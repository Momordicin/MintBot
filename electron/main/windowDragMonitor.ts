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
