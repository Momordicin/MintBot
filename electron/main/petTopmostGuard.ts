// electron/main/petTopmostGuard.ts — 桌宠 overlay 置顶守卫：显示期间检测它是否被普通窗口压住或丢失置顶位，是则不抢焦点地放回最上层
// 用法：index.ts 在创建 overlay 后调 startPetTopmostGuard、will-quit 调 stopPetTopmostGuard；windowBehavior.ts 在桌宠由隐藏变显示时调 checkAndRepairPetTopmost；非 win32 平台为空操作
// 对应文件：electron/main/index.ts / electron/main/windowBehavior.ts / electron/main/activeWindowMonitor.ts / electron/main/petTopmostGuard.test.ts
import koffi from 'koffi'
import type { BrowserWindow } from 'electron'
import { isCloaked, resolveClassName, resolveExeName, resolvePid } from './activeWindowMonitor'

const lib = process.platform === 'win32' ? koffi.load('user32.dll') : null

const GUARD_RECT = lib
  ? koffi.struct('PetTopmostGuardRect', {
      left: 'int32_t',
      top: 'int32_t',
      right: 'int32_t',
      bottom: 'int32_t',
    })
  : null

const GetWindow = lib ? lib.func('void * __stdcall GetWindow(void *hWnd, uint32_t uCmd)') : null
const IsWindowVisible = lib ? lib.func('bool __stdcall IsWindowVisible(void *hWnd)') : null
const IsIconic = lib ? lib.func('bool __stdcall IsIconic(void *hWnd)') : null
const GetWindowLongW = lib ? lib.func('int32_t __stdcall GetWindowLongW(void *hWnd, int32_t nIndex)') : null
const GetWindowRect = lib && GUARD_RECT ? lib.func('bool __stdcall GetWindowRect(void *hWnd, _Out_ PetTopmostGuardRect *lpRect)') : null
const SetWindowPos = lib
  ? lib.func('bool __stdcall SetWindowPos(void *hWnd, intptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)')
  : null

const GW_HWNDPREV = 3
const GWL_EXSTYLE = -20
const WS_EX_TOPMOST = 0x8
const HWND_TOPMOST = -1
const SWP_NOSIZE = 0x1
const SWP_NOMOVE = 0x2
const SWP_NOACTIVATE = 0x10

const MAX_WALK_STEPS = 4096
const CHECK_INTERVAL_MS = 3000
const LOG_INTERVAL_MS = 60_000

export type WindowAboveState = {
  hwnd: bigint
  visible: boolean
  cloaked: boolean
  iconic: boolean
  emptyRect: boolean
  topmost: boolean
}

export type TopmostVerdict =
  | { buried: false }
  | { buried: true; reason: 'own-bit-missing' }
  | { buried: true; reason: 'covered'; offender: WindowAboveState }

export function evaluatePetTopmost(ownTopmost: boolean, windowsAbove: readonly WindowAboveState[]): TopmostVerdict {
  if (!ownTopmost) return { buried: true, reason: 'own-bit-missing' }
  const offender = windowsAbove.find(w => w.visible && !w.cloaked && !w.iconic && !w.emptyRect && !w.topmost)
  return offender ? { buried: true, reason: 'covered', offender } : { buried: false }
}

export function shouldLogRepair(lastLoggedAtMs: number | null, nowMs: number): boolean {
  return lastLoggedAtMs === null || nowMs - lastLoggedAtMs >= LOG_INTERVAL_MS
}

let lastLoggedAtMs: number | null = null

function logLimited(message: string): void {
  const now = Date.now()
  if (!shouldLogRepair(lastLoggedAtMs, now)) return
  lastLoggedAtMs = now
  console.warn(`[PetTopmost] ${message}`)
}

function readExStyle(hwnd: unknown): number {
  return GetWindowLongW ? GetWindowLongW(hwnd, GWL_EXSTYLE) : 0
}

function readWindowAbove(hwnd: unknown): WindowAboveState {
  const rect = {} as { left: number; top: number; right: number; bottom: number }
  const gotRect = GetWindowRect ? GetWindowRect(hwnd, rect) : false
  return {
    hwnd: koffi.address(hwnd),
    visible: IsWindowVisible ? IsWindowVisible(hwnd) : false,
    cloaked: isCloaked(hwnd),
    iconic: IsIconic ? IsIconic(hwnd) : false,
    emptyRect: !gotRect || rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0,
    topmost: (readExStyle(hwnd) & WS_EX_TOPMOST) !== 0,
  }
}

function describeOffender(offender: WindowAboveState): string {
  const pid = resolvePid(offender.hwnd)
  const exe = pid !== null ? resolveExeName(pid) : null
  return `covered by exe=${exe ?? 'unknown'} class=${resolveClassName(offender.hwnd) || 'unknown'}`
}

export function checkAndRepairPetTopmost(win: BrowserWindow | null): void {
  if (process.platform !== 'win32' || !GetWindow || !SetWindowPos || !GetWindowLongW) return
  if (!win || win.isDestroyed() || !win.isVisible()) return

  try {
    const petHwnd = koffi.decode(win.getNativeWindowHandle(), 'void *')
    const ownTopmost = (readExStyle(petHwnd) & WS_EX_TOPMOST) !== 0

    const windowsAbove: WindowAboveState[] = []
    let current = GetWindow(petHwnd, GW_HWNDPREV)
    for (let step = 0; current && step < MAX_WALK_STEPS; step++) {
      windowsAbove.push(readWindowAbove(current))
      current = GetWindow(current, GW_HWNDPREV)
    }

    const verdict = evaluatePetTopmost(ownTopmost, windowsAbove)
    if (!verdict.buried) return

    const cause = verdict.reason === 'own-bit-missing' ? 'own topmost bit was missing' : describeOffender(verdict.offender)
    const ok = SetWindowPos(petHwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE)
    logLimited(ok ? `restored to topmost band (${cause})` : `SetWindowPos failed (${cause})`)
  } catch (err) {
    logLimited(`check failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

let timer: ReturnType<typeof setInterval> | null = null

export function startPetTopmostGuard(getOverlayWindow: () => BrowserWindow | null): void {
  if (process.platform !== 'win32' || timer) return
  timer = setInterval(() => checkAndRepairPetTopmost(getOverlayWindow()), CHECK_INTERVAL_MS)
}

export function stopPetTopmostGuard(): void {
  if (timer) clearInterval(timer)
  timer = null
}
