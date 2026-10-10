// electron/main/activeWindowMonitor.ts — Windows 前台窗口探测：经 koffi 调 user32/dwmapi/kernel32 读取前台窗口（标题、类名、exe、所在显示器、是否全屏），并探测已记录阻挡窗口是否仍存活
// 用法：startActiveWindowMonitor(onChange) 每 500ms 轮询，观测指纹变化才回调 ForegroundObservation（external / self / unavailable）；probeBlockerWindow(hwnd, pid) 返回 BlockerProbe；非 win32 平台为空操作或 unavailable
// 对应文件：electron/main/index.ts（startActiveWindowMonitoring）/ electron/main/foregroundWorldModel.ts / electron/main/displayStateMap.ts（BlockerProbe、ExternalWindowInfo 的使用方）/ electron/main/activeWindowMonitor.test.ts
import koffi from 'koffi'
import path from 'path'
import { screen } from 'electron'
import type { BlockerProbe } from './displayStateMap'

const lib = process.platform === 'win32' ? koffi.load('user32.dll') : null
const dwmapi = process.platform === 'win32' ? koffi.load('dwmapi.dll') : null
const kernel32 = process.platform === 'win32' ? koffi.load('kernel32.dll') : null

const HWND = lib ? koffi.pointer('HWND', koffi.opaque()) : null
const RECT = lib
  ? koffi.struct('RECT', {
      left: 'int32_t',
      top: 'int32_t',
      right: 'int32_t',
      bottom: 'int32_t',
    })
  : null

const GET_WINDOW_TEXT_OUT_TYPE = 'char16_t *'

const GetForegroundWindow = lib ? lib.func('HWND __stdcall GetForegroundWindow()') : null
const GetWindowTextW = lib
  ? lib.func(`int __stdcall GetWindowTextW(HWND hWnd, _Out_ ${GET_WINDOW_TEXT_OUT_TYPE} lpString, int nMaxCount)`)
  : null
const GetClassNameW = lib
  ? lib.func(`int __stdcall GetClassNameW(HWND hWnd, _Out_ ${GET_WINDOW_TEXT_OUT_TYPE} lpClassName, int nMaxCount)`)
  : null
const GetWindowRect = lib ? lib.func('bool __stdcall GetWindowRect(HWND hWnd, _Out_ RECT *lpRect)') : null

const GetWindowThreadProcessId = lib
  ? lib.func('uint32_t __stdcall GetWindowThreadProcessId(HWND hWnd, _Out_ uint32_t *lpdwProcessId)')
  : null
const OpenProcess = kernel32
  ? kernel32.func('HWND __stdcall OpenProcess(uint32_t dwDesiredAccess, bool bInheritHandle, uint32_t dwProcessId)')
  : null
const QueryFullProcessImageNameW = kernel32
  ? kernel32.func(
      `bool __stdcall QueryFullProcessImageNameW(HWND hProcess, uint32_t dwFlags, _Out_ ${GET_WINDOW_TEXT_OUT_TYPE} lpExeName, _Inout_ uint32_t *lpdwSize)`
    )
  : null
const CloseHandle = kernel32 ? kernel32.func('bool __stdcall CloseHandle(HWND hObject)') : null
const GetWindowLongW = lib ? lib.func('int32_t __stdcall GetWindowLongW(HWND hWnd, int32_t nIndex)') : null
const IsWindow = lib ? lib.func('bool __stdcall IsWindow(HWND hWnd)') : null
const IsWindowVisible = lib ? lib.func('bool __stdcall IsWindowVisible(HWND hWnd)') : null
const IsIconic = lib ? lib.func('bool __stdcall IsIconic(HWND hWnd)') : null
const DwmGetWindowAttribute = dwmapi
  ? dwmapi.func('int32_t __stdcall DwmGetWindowAttribute(HWND hwnd, uint32_t dwAttribute, _Out_ uint32_t *pvAttribute, uint32_t cbAttribute)')
  : null

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

const DWMWA_CLOAKED = 14

const GWL_STYLE = -16
const WS_CAPTION = 0xc00000
const WS_THICKFRAME = 0x40000

const FULLSCREEN_TOLERANCE_DIP = 2

type PlainRect = { x: number; y: number; width: number; height: number }

export function isFullscreenRect(dipRect: PlainRect, displayBounds: PlainRect, style: number): boolean {
  const rectMatchesDisplay =
    Math.abs(dipRect.x - displayBounds.x) <= FULLSCREEN_TOLERANCE_DIP &&
    Math.abs(dipRect.y - displayBounds.y) <= FULLSCREEN_TOLERANCE_DIP &&
    Math.abs(dipRect.x + dipRect.width - (displayBounds.x + displayBounds.width)) <= FULLSCREEN_TOLERANCE_DIP &&
    Math.abs(dipRect.y + dipRect.height - (displayBounds.y + displayBounds.height)) <= FULLSCREEN_TOLERANCE_DIP

  const hasCaptionOrThickFrame = (style & (WS_CAPTION | WS_THICKFRAME)) !== 0
  return rectMatchesDisplay && !hasCaptionOrThickFrame
}

export type ExternalWindowInfo = {
  hwnd: bigint
  pid: number | null
  title: string
  className: string
  isFullscreen: boolean
  exeName: string | null
  displayId: number
}

export type ForegroundObservation =
  | { kind: 'external'; info: ExternalWindowInfo }
  | { kind: 'self' }
  | { kind: 'unavailable' }


function resolvePid(hwnd: unknown): number | null {
  if (!GetWindowThreadProcessId) return null
  const pidBuf = [0]
  GetWindowThreadProcessId(hwnd, pidBuf)
  const pid = pidBuf[0]
  return pid || null
}

function resolveClassName(hwnd: unknown): string {
  if (!GetClassNameW) return ''
  const classBuf = ['\0'.repeat(255)]
  const len = GetClassNameW(hwnd, classBuf, 256)
  return len > 0 ? classBuf[0].slice(0, len) : ''
}

function isCloaked(hwnd: unknown): boolean {
  if (!DwmGetWindowAttribute) return false
  const cloakedBuf = [0]
  const hr = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, cloakedBuf, 4)
  return hr === 0 && cloakedBuf[0] !== 0
}

function resolveExeName(pid: number): string | null {
  if (!OpenProcess || !QueryFullProcessImageNameW || !CloseHandle) {
    return null
  }

  let processHandle: unknown = null
  try {
    processHandle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
    if (!processHandle) return null

    const exeNameBuf = ['\0'.repeat(255)]
    const sizeBuf = [256]
    const ok = QueryFullProcessImageNameW(processHandle, 0, exeNameBuf, sizeBuf)
    if (!ok) return null

    return path.basename(exeNameBuf[0])
  } catch {
    return null
  } finally {
    if (processHandle) CloseHandle(processHandle)
  }
}

function measureWindow(hwnd: unknown): { displayId: number; isFullscreen: boolean } | null {
  if (!GetWindowRect || !GetWindowLongW) return null

  const rect = {} as { left: number; top: number; right: number; bottom: number }
  const gotRect = GetWindowRect(hwnd, rect)
  if (!gotRect) return null

  const physicalRect = {
    x: rect.left,
    y: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
  }
  const dipRect = screen.screenToDipRect(null, physicalRect)
  const display = screen.getDisplayMatching(dipRect)

  const style = GetWindowLongW(hwnd, GWL_STYLE)
  return { displayId: display.id, isFullscreen: isFullscreenRect(dipRect, display.bounds, style) }
}

export function getActiveWindowInfo(): ForegroundObservation {
  if (
    process.platform !== 'win32' ||
    !GetForegroundWindow ||
    !GetWindowTextW ||
    !GetWindowRect ||
    !RECT ||
    !GetWindowLongW ||
    !GetWindowThreadProcessId
  ) {
    return { kind: 'unavailable' }
  }

  try {
    const hwnd = GetForegroundWindow()
    if (!hwnd) return { kind: 'unavailable' }

    const titleBuf = ['\0'.repeat(255)]
    GetWindowTextW(hwnd, titleBuf, 256)
    const title = titleBuf[0]

    const className = resolveClassName(hwnd)

    const measured = measureWindow(hwnd)
    if (!measured) return { kind: 'unavailable' }
    const { displayId, isFullscreen } = measured

    const pid = resolvePid(hwnd)
    const exeName = pid !== null ? resolveExeName(pid) : null

    if (exeName !== null && exeName.toLowerCase() === path.basename(process.execPath).toLowerCase()) {
      return { kind: 'self' }
    }

    return {
      kind: 'external',
      info: { hwnd: koffi.address(hwnd), pid, title, className, isFullscreen, exeName, displayId },
    }
  } catch {
    return { kind: 'unavailable' }
  }
}

export function observationFingerprint(observation: ForegroundObservation): string {
  if (observation.kind !== 'external') return observation.kind
  const { hwnd, isFullscreen, exeName, displayId } = observation.info
  return `external:${hwnd}:${isFullscreen}:${exeName}:${displayId}`
}

export function startActiveWindowMonitor(onChange: (observation: ForegroundObservation) => void): () => void {
  if (process.platform !== 'win32') {
    return () => {}
  }

  let previousFingerprint: string | null = null

  const handle = setInterval(() => {
    const current = getActiveWindowInfo()
    const currentFingerprint = observationFingerprint(current)

    if (currentFingerprint !== previousFingerprint) {
      previousFingerprint = currentFingerprint
      onChange(current)
    }
  }, 500)

  return () => clearInterval(handle)
}

const hwndsWithLoggedProbeError = new Set<bigint>()

function logProbeErrorOnce(hwnd: bigint, reason: string): void {
  if (hwndsWithLoggedProbeError.has(hwnd)) return
  hwndsWithLoggedProbeError.add(hwnd)
  console.error(
    `[activeWindowMonitor] probeBlockerWindow: could not determine state for hwnd=${hwnd} (${reason}); keeping the existing blocker rather than treating this as evidence it is gone`
  )
}

export function classifyPidCheck(currentPid: number | null, expectedPid: number): 'match' | 'pid-mismatch' | 'probe-error' {
  if (currentPid === null) return 'probe-error'
  if (currentPid !== expectedPid) return 'pid-mismatch'
  return 'match'
}

export function classifyRectProbe(gotRect: boolean): 'ok' | 'probe-error' {
  return gotRect ? 'ok' : 'probe-error'
}

export function probeBlockerWindow(hwnd: bigint, pid: number): BlockerProbe {
  if (!IsWindow || !GetWindowThreadProcessId || !GetWindowRect || !RECT || !GetWindowLongW) {
    return { status: 'gone' }
  }

  try {
    if (!IsWindow(hwnd)) {
      hwndsWithLoggedProbeError.delete(hwnd)
      return { status: 'gone' }
    }

    const currentPid = resolvePid(hwnd)
    const pidCheck = classifyPidCheck(currentPid, pid)
    if (pidCheck === 'probe-error') {
      logProbeErrorOnce(hwnd, 'GetWindowThreadProcessId failed to resolve a pid')
      return { status: 'probe-error' }
    }
    if (pidCheck === 'pid-mismatch') {
      hwndsWithLoggedProbeError.delete(hwnd)
      return { status: 'pid-mismatch' }
    }

    if (IsWindowVisible && IsIconic && (!IsWindowVisible(hwnd) || IsIconic(hwnd) || isCloaked(hwnd))) {
      hwndsWithLoggedProbeError.delete(hwnd)
      return { status: 'hidden' }
    }

    const measured = measureWindow(hwnd)
    if (classifyRectProbe(measured !== null) === 'probe-error' || measured === null) {
      logProbeErrorOnce(hwnd, 'GetWindowRect failed after IsWindow/pid checks already passed')
      return { status: 'probe-error' }
    }

    hwndsWithLoggedProbeError.delete(hwnd)
    return { status: 'ok', displayId: measured.displayId, isFullscreen: measured.isFullscreen }
  } catch (err) {
    logProbeErrorOnce(hwnd, err instanceof Error ? err.message : String(err))
    return { status: 'probe-error' }
  }
}
