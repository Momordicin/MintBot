// electron/main/nativeWindowDrag.ts — 经 koffi 调 user32，对指定窗口发起系统原生的窗口移动循环（SC_MOVE | HTCAPTION）
// 用法：electron/main/index.ts 的 overlay:start-drag 处理端调用 startNativeWindowDrag
// 形状：输入 BrowserWindow；无返回值
// 对应文件：electron/main/index.ts / electron/main/nativeWindowDrag.test.ts / electron/main/windowDragMonitor.ts
import koffi from 'koffi'
import type { BrowserWindow } from 'electron'

const WM_SYSCOMMAND = 0x0112
const SC_DRAGMOVE = 0xf012

const lib = process.platform === 'win32' ? koffi.load('user32.dll') : null

const ReleaseCapture = lib ? lib.func('bool __stdcall ReleaseCapture()') : null
const PostMessageW = lib
  ? lib.func('bool __stdcall PostMessageW(void *hWnd, uint32_t Msg, uintptr_t wParam, intptr_t lParam)')
  : null

export function startNativeWindowDrag(win: BrowserWindow): void {
  if (process.platform !== 'win32' || !ReleaseCapture || !PostMessageW) return
  if (win.isDestroyed()) return
  const hwnd = koffi.decode(win.getNativeWindowHandle(), 'void *')
  ReleaseCapture()
  if (!PostMessageW(hwnd, WM_SYSCOMMAND, SC_DRAGMOVE, 0)) {
    console.warn('[NativeWindowDrag] PostMessageW(WM_SYSCOMMAND, SC_DRAGMOVE) failed')
  }
}
