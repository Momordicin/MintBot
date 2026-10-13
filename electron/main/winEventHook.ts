// electron/main/winEventHook.ts — 经 koffi 注册 Windows WinEvent 全局钩子，把前台切换、最小化、销毁/隐藏、位置变化、cloak 事件转成 (event, hwnd) 回调
// 用法：foregroundWorldModel.ts 的 startDesktopObservation 调 startWinEventHooks(onEvent)，返回的函数用于注销；导出 EVENT_* 常量；非 win32 平台为空操作
// 形状：onEvent(event: number, hwnd: bigint)，仅传 idObject 与 idChild 均为 0（窗口自身）的事件
// 对应文件：electron/main/foregroundWorldModel.ts / electron/main/foregroundWorldModel.test.ts
import koffi from 'koffi'

export const EVENT_SYSTEM_FOREGROUND = 0x0003
export const EVENT_SYSTEM_MINIMIZESTART = 0x0016
export const EVENT_SYSTEM_MINIMIZEEND = 0x0017
export const EVENT_OBJECT_DESTROY = 0x8001
export const EVENT_OBJECT_SHOW = 0x8002
export const EVENT_OBJECT_HIDE = 0x8003
export const EVENT_OBJECT_LOCATIONCHANGE = 0x800b
export const EVENT_OBJECT_CLOAKED = 0x8017
export const EVENT_OBJECT_UNCLOAKED = 0x8018

const WINEVENT_OUTOFCONTEXT = 0
const WINEVENT_SKIPOWNPROCESS = 2
const OBJID_WINDOW = 0
const CHILDID_SELF = 0

const lib = process.platform === 'win32' ? koffi.load('user32.dll') : null

const WinEventProc = lib
  ? koffi.proto(
      'void __stdcall WinEventProc(void *hook, uint32_t event, void *hwnd, int32_t idObject, int32_t idChild, uint32_t thread, uint32_t time)'
    )
  : null

const SetWinEventHook =
  lib && WinEventProc
    ? lib.func(
        'void * __stdcall SetWinEventHook(uint32_t eventMin, uint32_t eventMax, void *hmodWinEventProc, WinEventProc *pfn, uint32_t idProcess, uint32_t idThread, uint32_t dwFlags)'
      )
    : null
const UnhookWinEvent = lib ? lib.func('bool __stdcall UnhookWinEvent(void *hWinEventHook)') : null

type HookRange = { min: number; max: number; flags: number }

const HOOK_RANGES: HookRange[] = [
  { min: EVENT_SYSTEM_FOREGROUND, max: EVENT_SYSTEM_FOREGROUND, flags: WINEVENT_OUTOFCONTEXT },
  { min: EVENT_SYSTEM_MINIMIZESTART, max: EVENT_SYSTEM_MINIMIZEEND, flags: WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS },
  { min: EVENT_OBJECT_DESTROY, max: EVENT_OBJECT_HIDE, flags: WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS },
  { min: EVENT_OBJECT_LOCATIONCHANGE, max: EVENT_OBJECT_LOCATIONCHANGE, flags: WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS },
  { min: EVENT_OBJECT_CLOAKED, max: EVENT_OBJECT_UNCLOAKED, flags: WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS },
]

export function startWinEventHooks(onEvent: (event: number, hwnd: bigint) => void): () => void {
  if (process.platform !== 'win32' || !SetWinEventHook || !UnhookWinEvent || !WinEventProc) {
    return () => {}
  }

  const callback = koffi.register(
    (_hook: unknown, event: number, hwnd: unknown, idObject: number, idChild: number) => {
      if (idObject !== OBJID_WINDOW || idChild !== CHILDID_SELF) return
      onEvent(event, koffi.address(hwnd))
    },
    koffi.pointer(WinEventProc)
  )

  const handles: unknown[] = []
  for (const range of HOOK_RANGES) {
    const handle = SetWinEventHook(range.min, range.max, null, callback, 0, 0, range.flags)
    if (!handle) {
      console.error(
        `[WinEventHook] SetWinEventHook failed for event range 0x${range.min.toString(16)}-0x${range.max.toString(16)}`
      )
      continue
    }
    handles.push(handle)
  }
  if (handles.length === 0) {
    console.error('[WinEventHook] no WinEvent hooks registered; desktop observation will not update until restart or unlock')
  }

  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    for (const handle of handles) UnhookWinEvent(handle)
    koffi.unregister(callback)
  }
}
