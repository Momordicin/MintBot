// electron/main/foregroundWorldModel.ts — 主进程持有的显示器阻挡表（模块内变量）及其更新与周期校验
// 用法：updateDisplayStateMap(observation) 仅吸收 external 观测；startBlockerValidationLoop(onValidated) 每 1500ms 校验并回调（非 win32 为空操作）；revalidateBlockersNow({ forceConservative }) 立即校验一次；getDisplayStateMap() 读取
// 对应文件：electron/main/index.ts / electron/main/windowBehavior.ts / electron/main/activeWindowMonitor.ts / electron/main/displayStateMap.ts / electron/main/dragActivity.ts / electron/main/foregroundWorldModel.test.ts
import { probeBlockerWindow, getActiveWindowInfo } from './activeWindowMonitor'
import type { ForegroundObservation } from './activeWindowMonitor'
import { getWindowBehaviorRules } from './windowBehavior'
import { applyExternalObservation, validateBlockers } from './displayStateMap'
import type { DisplayStateMap, ValidationMode } from './displayStateMap'
import { isWindowDragInProgress } from './dragActivity'

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

function runValidationPass(forceConservative = false): void {
  const mode = selectValidationMode(getActiveWindowInfo().kind === 'self', isWindowDragInProgress('overlay'), forceConservative)
  displayStateMap = validateBlockers(displayStateMap, getWindowBehaviorRules(), probeBlockerWindow, mode)
}

export function revalidateBlockersNow(options?: { forceConservative?: boolean }): void {
  runValidationPass(options?.forceConservative === true)
}

const BLOCKER_VALIDATION_INTERVAL_MS = 1500

export function startBlockerValidationLoop(onValidated: () => void): () => void {
  if (process.platform !== 'win32') {
    return () => {}
  }

  runValidationPass()
  onValidated()
  const handle = setInterval(() => {
    runValidationPass()
    onValidated()
  }, BLOCKER_VALIDATION_INTERVAL_MS)
  return () => clearInterval(handle)
}
