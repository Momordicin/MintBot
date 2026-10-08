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
