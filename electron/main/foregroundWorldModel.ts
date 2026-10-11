// electron/main/foregroundWorldModel.ts — 主进程持有的显示器阻挡表（模块内变量）及其更新，并由 WinEvent 事件驱动前台观测与阻挡校验
// 用法：updateDisplayStateMap(observation) 仅吸收 external 观测；startDesktopObservation(onObservation, onChanged) 注册 WinEvent 钩子并立即做一次观测，返回停止函数；requestObservation({ force }) 在观测运行期间请求一次合并的观测（force 时即使指纹未变也上报）；shouldScheduleObservation 判断事件是否触发观测；revalidateBlockersNow({ forceConservative }) 立即校验一次；getDisplayStateMap() 读取
// 对应文件：electron/main/index.ts / electron/main/windowBehavior.ts / electron/main/activeWindowMonitor.ts / electron/main/displayStateMap.ts / electron/main/dragActivity.ts / electron/main/winEventHook.ts / electron/main/foregroundWorldModel.test.ts
import { probeBlockerWindow, getActiveWindowInfo, observationFingerprint } from './activeWindowMonitor'
import type { ForegroundObservation } from './activeWindowMonitor'
import { getWindowBehaviorRules } from './windowBehavior'
import { applyExternalObservation, validateBlockers, displayStateMapsEqual } from './displayStateMap'
import type { DisplayStateMap, ValidationMode } from './displayStateMap'
import { isWindowDragInProgress } from './dragActivity'
import { startWinEventHooks, EVENT_SYSTEM_FOREGROUND } from './winEventHook'

let displayStateMap: DisplayStateMap = new Map()

export function getDisplayStateMap(): DisplayStateMap {
  return displayStateMap
}

export function updateDisplayStateMap(observation: ForegroundObservation): void {
  if (observation.kind !== 'external') return
  displayStateMap = applyExternalObservation(displayStateMap, observation.info, getWindowBehaviorRules())
}

export function selectValidationMode(
  isSelfForeground: boolean,
  isDragInProgress: boolean,
  forceConservative = false
): ValidationMode {
  return forceConservative || isSelfForeground || isDragInProgress ? 'conservative' : 'standard'
}

function runValidationPass(forceConservative = false, observation?: ForegroundObservation): void {
  const isSelfForeground = observation ? observation.kind === 'self' : getActiveWindowInfo().kind === 'self'
  const mode = selectValidationMode(isSelfForeground, isWindowDragInProgress('overlay'), forceConservative)
  displayStateMap = validateBlockers(displayStateMap, getWindowBehaviorRules(), probeBlockerWindow, mode)
}

export function revalidateBlockersNow(options?: { forceConservative?: boolean }): void {
  runValidationPass(options?.forceConservative === true)
}

let previousFingerprint: string | null = null
let foregroundHwnd: bigint | null = null
let passScheduled = false
let pendingPass: ReturnType<typeof setImmediate> | null = null
let forceNextPass = false
let observing = false
let activeOnObservation: ((observation: ForegroundObservation) => void) | null = null
let activeOnChanged: (() => void) | null = null

export function shouldScheduleObservation(
  event: number,
  hwnd: bigint,
  currentForegroundHwnd: bigint | null,
  blockerHwnds: ReadonlySet<bigint>
): boolean {
  if (event === EVENT_SYSTEM_FOREGROUND) return true
  return hwnd === currentForegroundHwnd || blockerHwnds.has(hwnd)
}

function resetObservationState(): void {
  if (pendingPass !== null) clearImmediate(pendingPass)
  pendingPass = null
  passScheduled = false
  forceNextPass = false
  observing = false
  activeOnObservation = null
  activeOnChanged = null
  previousFingerprint = null
  foregroundHwnd = null
}

function runObservationPass(force: boolean): void {
  const observation = getActiveWindowInfo()
  if (observation.kind === 'external') foregroundHwnd = observation.info.hwnd
  const fingerprint = observationFingerprint(observation)
  let changed = false

  if (force || fingerprint !== previousFingerprint) {
    previousFingerprint = fingerprint
    updateDisplayStateMap(observation)
    activeOnObservation?.(observation)
    changed = true
  }

  const before = displayStateMap
  runValidationPass(false, observation)
  if (!displayStateMapsEqual(before, displayStateMap)) changed = true

  if (changed) activeOnChanged?.()
}

function schedulePass(): void {
  if (passScheduled) return
  passScheduled = true
  pendingPass = setImmediate(() => {
    passScheduled = false
    pendingPass = null
    const force = forceNextPass
    forceNextPass = false
    try {
      runObservationPass(force)
    } catch (err) {
      console.error('[DesktopObservation] observation pass failed:', err)
    }
  })
}

function handleWinEvent(event: number, hwnd: bigint): void {
  if (event === EVENT_SYSTEM_FOREGROUND) foregroundHwnd = hwnd
  const blockerHwnds = new Set<bigint>()
  for (const blocker of displayStateMap.values()) blockerHwnds.add(blocker.hwnd)
  if (shouldScheduleObservation(event, hwnd, foregroundHwnd, blockerHwnds)) schedulePass()
}

export function requestObservation(options?: { force?: boolean }): void {
  if (!observing) return
  if (options?.force) forceNextPass = true
  schedulePass()
}

export function startDesktopObservation(
  onObservation: (observation: ForegroundObservation) => void,
  onChanged: () => void
): () => void {
  activeOnObservation = onObservation
  activeOnChanged = onChanged
  observing = true

  const stopHooks = startWinEventHooks(handleWinEvent)
  try {
    runObservationPass(true)
  } catch (err) {
    stopHooks()
    resetObservationState()
    throw err
  }

  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    stopHooks()
    resetObservationState()
  }
}
