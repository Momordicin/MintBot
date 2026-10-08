import koffi from 'koffi'
import path from 'path'
import { screen } from 'electron'
import type { BlockerProbe } from './displayStateMap'

const lib = process.platform === 'win32' ? koffi.load('user32.dll') : null
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

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

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

    const rect = {} as { left: number; top: number; right: number; bottom: number }
    const gotRect = GetWindowRect(hwnd, rect)
    if (!gotRect) return { kind: 'unavailable' }

    const physicalRect = {
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    }
    const dipRect = screen.screenToDipRect(null, physicalRect)
    const display = screen.getDisplayMatching(dipRect)

    const style = GetWindowLongW(hwnd, GWL_STYLE)
    const isFullscreen = isFullscreenRect(dipRect, display.bounds, style)

    const pid = resolvePid(hwnd)
    const exeName = pid !== null ? resolveExeName(pid) : null

    if (exeName !== null && exeName.toLowerCase() === path.basename(process.execPath).toLowerCase()) {
      return { kind: 'self' }
    }

    return {
      kind: 'external',
      info: { hwnd: koffi.address(hwnd), pid, title, isFullscreen, exeName, displayId: display.id },
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

    const rect = {} as { left: number; top: number; right: number; bottom: number }
    const gotRect = GetWindowRect(hwnd, rect)
    if (classifyRectProbe(gotRect) === 'probe-error') {
      logProbeErrorOnce(hwnd, 'GetWindowRect failed after IsWindow/pid checks already passed')
      return { status: 'probe-error' }
    }

    const physicalRect = {
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    }
    const dipRect = screen.screenToDipRect(null, physicalRect)
    const display = screen.getDisplayMatching(dipRect)
    const style = GetWindowLongW(hwnd, GWL_STYLE)
    const isFullscreen = isFullscreenRect(dipRect, display.bounds, style)

    hwndsWithLoggedProbeError.delete(hwnd)
    return { status: 'ok', displayId: display.id, isFullscreen }
  } catch (err) {
    logProbeErrorOnce(hwnd, err instanceof Error ? err.message : String(err))
    return { status: 'probe-error' }
  }
}
