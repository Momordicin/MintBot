// electron/main/windowBehavior.ts — 窗口行为编排：缓存 window-behavior 配置快照，按显示器阻挡表为桌宠与聊天窗口套用迁移、置顶、显示/隐藏、贴边，并处理拖拽落点持久化、overlay 尺寸与收起手柄几何、穿透与透明度
// 用法：index.ts 启动与事件里调 initWindowBehaviorConfig / applyWindowBehaviorSnapshot / evaluateDesktopPresence / handleWindowMoved / requestOverlayEdgeHover / applyOverlaySize / getCurrentPetMode / noteOverlayCreatedCollapsed / setPetHandleWindow 等；向 overlay 发 desktop-presence:changed，并同步穿透手柄窗口的位置与显隐
// 形状：输入 WindowBehaviorSnapshot（core GET/PATCH /config/window-behavior 与 SSE window-behavior-changed）和阻挡表；输出为对 BrowserWindow 的操作与 IPC 推送
// 对应文件：electron/main/index.ts / electron/main/desktopPresence.ts / electron/main/foregroundWorldModel.ts / electron/main/windowPositions.ts / electron/main/windowAnimation.ts / electron/main/petHandleWindow.ts / shared/windowBehavior.ts / electron/main/windowBehavior.test.ts
import { BrowserWindow, screen } from 'electron'
import { animateTo } from './windowAnimation'
import { syncPetHandleBounds, setPetHandleVisible } from './petHandleWindow'
import {
  getPreferredBounds,
  setPreferredBounds,
  getEffectiveHomeDisplay,
  computeDefaultBoundsForDisplay,
  computeAnchoredResizeBounds,
  collapsedHandleBounds,
  expandedBoundsFromHandle,
  COLLAPSED_SIZE,
  clampBoundsToWorkArea,
  DEFAULT_WINDOW_SIZE,
  PERSIST_DEBOUNCE_MS,
} from './windowPositions'
import type { Bounds, WindowKey } from './windowPositions'
import { commitHomeDisplayFromDragOutcome } from './homeDisplayCommit'
import { getDisplayStateMap, revalidateBlockersNow, requestObservation } from './foregroundWorldModel'
import type { AppRule } from './displayStateMap'
import {
  resolvePetDesiredState,
  resolveChatDesiredState,
  diffPetState,
  diffChatState,
  resolveDragOutcome,
  deriveDragContext,
  isTemporaryPlacement,
  isProgrammaticMoveEcho,
  extendQuietUntil,
  resolveEdgeSide,
  resolveStableEdgeSide,
  computeEdgeBounds,
  EDGE_VISIBLE_SLIVER_PX,
  resolveEdgeHoverBounds,
  presencePayloadChanged,
  computeHandleSuppressed,
  petMode,
  petModeIgnoresMouse,
  petModeTargetOpacity,
} from './desktopPresence'
import type { EdgeSide, DesiredPetState, PetMode, PetPresence, PetPresencePayload } from './desktopPresence'
import { isWindowDragInProgress, endDragTail } from './dragActivity'
import { CORE_URL } from './coreUrl'
import { isNewerSnapshot } from '../../shared/windowBehavior.js'
import type { WindowBehaviorConfig, WindowBehaviorSnapshot } from '../../shared/windowBehavior.js'

const PIN_LEVEL: NonNullable<Parameters<BrowserWindow['setAlwaysOnTop']>[1]> = 'screen-saver'

const lastAppliedOnTop: Record<WindowKey, boolean | null> = { overlay: null, chat: null }

function applyAlwaysOnTop(win: BrowserWindow, windowKey: WindowKey, onTop: boolean): void {
  if (lastAppliedOnTop[windowKey] === onTop) return
  win.setAlwaysOnTop(onTop, PIN_LEVEL)
  lastAppliedOnTop[windowKey] = onTop
}

const DEFAULT_CONFIG: WindowBehaviorConfig = {
  chatPinMode: 'off',
  petAvoidanceEnabled: true,
  petClickThrough: false,
  petCollapsed: false,
  appRules: [],
}

let cachedSnapshot: WindowBehaviorSnapshot | null = null

function currentConfig(): WindowBehaviorConfig {
  return cachedSnapshot?.config ?? DEFAULT_CONFIG
}

function acceptSnapshot(snapshot: WindowBehaviorSnapshot): boolean {
  if (!isNewerSnapshot(cachedSnapshot, snapshot)) return false
  cachedSnapshot = { ...snapshot, config: { ...DEFAULT_CONFIG, ...snapshot.config } }
  return true
}

export function getCachedWindowBehaviorConfig(): WindowBehaviorConfig {
  return currentConfig()
}

export function getCurrentPetMode(): PetMode {
  return petMode(appliedPetCollapsed, currentConfig().petClickThrough)
}

let petHandleWindow: BrowserWindow | null = null

export function setPetHandleWindow(win: BrowserWindow | null): void {
  petHandleWindow = win
}

function targetOpacityFor(windowKey: WindowKey): number {
  return windowKey === 'overlay' ? petModeTargetOpacity(getCurrentPetMode()) : 1
}

export function getWindowBehaviorRules(): { appRules: AppRule[] } {
  return { appRules: currentConfig().appRules }
}

let startupGateOpen = true
let windowBehaviorConfigSettled = false

const WINDOW_BEHAVIOR_FETCH_TIMEOUT_MS = 3000

export function closeStartupGate(): void {
  startupGateOpen = false
}

export function openStartupGate(): void {
  startupGateOpen = true
}

let appliedPetDisplayId: number | null = null
let appliedChatDisplayId: number | null = null
let appliedChatPresence: 'SHOWN' | 'NORMAL' | 'SUPPRESSED' | null = null

export async function initWindowBehaviorConfig(mainWindow: BrowserWindow | null, overlayWindow: BrowserWindow | null): Promise<void> {
  try {
    const response = await fetch(`${CORE_URL}/config/window-behavior`, { signal: AbortSignal.timeout(WINDOW_BEHAVIOR_FETCH_TIMEOUT_MS) })
    if (response.ok) {
      acceptSnapshot((await response.json()) as WindowBehaviorSnapshot)
    }
  } catch (err) {
    console.error('[WindowBehavior] Failed to fetch initial config, using defaults:', err)
  }
  windowBehaviorConfigSettled = true
  requestObservation({ force: true })
  try {
    evaluateDesktopPresence(mainWindow, overlayWindow)
  } catch (err) {
    console.error('[WindowBehavior] Failed to apply pin state:', err)
  }
}

export function applyWindowBehaviorSnapshot(
  snapshot: WindowBehaviorSnapshot,
  mainWindow: BrowserWindow | null,
  overlayWindow: BrowserWindow | null
): boolean {
  if (!acceptSnapshot(snapshot)) return false
  requestObservation({ force: true })
  evaluateDesktopPresence(mainWindow, overlayWindow)
  return true
}

const programmaticMoveInFlight = new Set<WindowKey>()
const programmaticQuietUntil = new Map<WindowKey, number>()

function markProgrammaticQuiet(windowKey: WindowKey, ms: number): void {
  programmaticQuietUntil.set(
    windowKey,
    extendQuietUntil(programmaticQuietUntil.get(windowKey) ?? 0, Date.now(), ms)
  )
}

const programmaticMoveGeneration = new Map<WindowKey, number>()

const activeAnimationCancelFor = new Map<WindowKey, () => void>()

function beginProgrammaticMove(windowKey: WindowKey): { generation: number; onComplete: () => boolean } {
  const generation = (programmaticMoveGeneration.get(windowKey) ?? 0) + 1
  programmaticMoveGeneration.set(windowKey, generation)
  programmaticMoveInFlight.add(windowKey)
  return {
    generation,
    onComplete: function onProgrammaticMoveComplete(): boolean {
      if (programmaticMoveGeneration.get(windowKey) !== generation) return false
      programmaticMoveInFlight.delete(windowKey)
      markProgrammaticQuiet(windowKey, PROGRAMMATIC_ECHO_TAIL_MS)
      return true
    },
  }
}

function setActiveAnimationCancelIfCurrent(windowKey: WindowKey, generation: number, cancel: () => void): void {
  if (programmaticMoveGeneration.get(windowKey) === generation) {
    activeAnimationCancelFor.set(windowKey, cancel)
  }
}

export function cancelProgrammaticMoveOnDragStart(windowKey: WindowKey): void {
  activeAnimationCancelFor.get(windowKey)?.()
}

export function markTopologySettle(): void {
  markProgrammaticQuiet('overlay', PROGRAMMATIC_MOVE_COOLDOWN_MS)
  markProgrammaticQuiet('chat', PROGRAMMATIC_MOVE_COOLDOWN_MS)
}

function isProgrammaticEchoFor(windowKey: WindowKey): boolean {
  return isProgrammaticMoveEcho(
    programmaticMoveInFlight.has(windowKey),
    programmaticQuietUntil.get(windowKey) ?? 0,
    Date.now()
  )
}

export function markProgrammaticWindowPlacement(windowKey: WindowKey): void {
  markProgrammaticQuiet(windowKey, PROGRAMMATIC_MOVE_COOLDOWN_MS)
}

const PROGRAMMATIC_MOVE_COOLDOWN_MS = 1000

const PROGRAMMATIC_ECHO_TAIL_MS = 150

const lastValidPlacement = new Map<WindowKey, { displayId: number; bounds: Electron.Rectangle }>()

function notePlacement(windowKey: WindowKey, displayId: number, bounds: Electron.Rectangle): void {
  const effectiveHomeDisplayId = getEffectiveHomeDisplay(screen.getAllDisplays(), windowKey).id
  if (isTemporaryPlacement(displayId, effectiveHomeDisplayId)) {
    lastValidPlacement.set(windowKey, { displayId, bounds })
  } else {
    lastValidPlacement.delete(windowKey)
  }
}

function moveToDisplay(win: BrowserWindow, windowKey: WindowKey, targetDisplayId: number, onSettled?: () => void): void {
  const displays = screen.getAllDisplays()
  const target = displays.find(display => display.id === targetDisplayId)
  if (!target) return

  let bounds = getPreferredBounds(windowKey, target.id)
  const defaultSize = windowKey === 'overlay'
    ? resolvePetSize(win.getBounds(), bounds, appliedPetCollapsed)
    : DEFAULT_WINDOW_SIZE[windowKey]
  if (!bounds) {
    bounds = computeDefaultBoundsForDisplay(target, displays, { width: defaultSize.width, height: defaultSize.height }, windowKey)
    setPreferredBounds(windowKey, target.id, bounds)
  } else {
    bounds = windowKey === 'overlay'
      ? computeAnchoredResizeBounds(bounds, defaultSize, target.workArea)
      : clampBoundsToWorkArea(bounds, target.workArea)
  }
  if (windowKey === 'overlay' && appliedPetCollapsed) bounds = collapsedHandleBounds(bounds)
  notePlacement(windowKey, target.id, bounds)

  const { generation, onComplete } = beginProgrammaticMove(windowKey)
  const cancel = animateTo(win, bounds, () => {
    const wasCurrent = onComplete()
    if (wasCurrent) onSettled?.()
  }, { finalOpacity: targetOpacityFor(windowKey) })
  setActiveAnimationCancelIfCurrent(windowKey, generation, cancel)
}

let latestPetDesired: DesiredPetState | null = null
let appliedPetPresence: PetPresence | null = null
let appliedPetEdgeSide: EdgeSide | null = null

let overlayEdgeHovered = false

function boundsEqual(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function computeEdgeFullBounds(
  target: Electron.Display,
  displays: Electron.Display[],
  currentBounds: Electron.Rectangle
): Electron.Rectangle {
  const preferredBounds = getPreferredBounds('overlay', target.id)
  const petSize = resolvePetSize(currentBounds, preferredBounds, appliedPetCollapsed)
  const expandedBounds = preferredBounds
    ? computeAnchoredResizeBounds(preferredBounds, petSize, target.workArea)
    : computeDefaultBoundsForDisplay(target, displays, { width: petSize.width, height: petSize.height }, 'overlay')
  const fullBounds = appliedPetCollapsed ? collapsedHandleBounds(expandedBounds) : expandedBounds
  return {
    x: fullBounds.x,
    y: currentBounds.y,
    width: currentBounds.width,
    height: currentBounds.height,
  }
}

function runPetEdgeController(
  overlayWindow: BrowserWindow,
  desired: DesiredPetState,
  isInteracting: boolean
): void {
  if (desired.presence !== 'EDGE') {
    overlayEdgeHovered = false

    if (appliedPetPresence !== 'EDGE' || isInteracting) {
      if (appliedPetPresence !== desired.presence) {
        settlePetPresence(overlayWindow, desired.presence, null, false)
      }
      return
    }

    if (programmaticMoveInFlight.has('overlay')) return

    const displays = screen.getAllDisplays()
    const target = displays.find(display => display.id === desired.displayId)
    if (!target) return

    const currentBounds = overlayWindow.getBounds()
    const restoredBounds = computeEdgeFullBounds(target, displays, currentBounds)

    if (boundsEqual(currentBounds, restoredBounds)) {
      settlePetPresence(overlayWindow, desired.presence, null, false)
      return
    }

    const { generation, onComplete } = beginProgrammaticMove('overlay')
    const cancel = animateTo(overlayWindow, restoredBounds, () => {
      if (onComplete()) settlePetPresence(overlayWindow, desired.presence, null, true)
    }, { finalOpacity: targetOpacityFor('overlay') })
    setActiveAnimationCancelIfCurrent('overlay', generation, cancel)
    return
  }

  if (isInteracting) return

  if (programmaticMoveInFlight.has('overlay')) return

  const displays = screen.getAllDisplays()
  const target = displays.find(display => display.id === desired.displayId)
  if (!target) return

  const currentBounds = overlayWindow.getBounds()
  const freshSide = resolveEdgeSide(currentBounds, target.bounds)
  const episodeStillActive = appliedPetPresence === 'EDGE'
  const stableSide = resolveStableEdgeSide(appliedPetEdgeSide, freshSide, episodeStillActive)

  const edgeBounds = computeEdgeBounds(currentBounds, target.bounds, stableSide, EDGE_VISIBLE_SLIVER_PX)
  const fullBoundsSameGeometry = computeEdgeFullBounds(target, displays, currentBounds)

  const desiredBounds = resolveEdgeHoverBounds(edgeBounds, fullBoundsSameGeometry, overlayEdgeHovered)
  if (boundsEqual(currentBounds, desiredBounds)) {
    settlePetPresence(overlayWindow, 'EDGE', stableSide, false)
    return
  }

  const { generation, onComplete } = beginProgrammaticMove('overlay')
  const cancel = animateTo(overlayWindow, desiredBounds, () => {
    if (onComplete()) settlePetPresence(overlayWindow, 'EDGE', stableSide, true)
  }, { finalOpacity: targetOpacityFor('overlay') })
  setActiveAnimationCancelIfCurrent('overlay', generation, cancel)
}

function settlePetPresence(
  overlayWindow: BrowserWindow,
  presence: PetPresence,
  edgeSide: EdgeSide | null,
  reevaluate: boolean
): void {
  appliedPetPresence = presence
  appliedPetEdgeSide = edgeSide
  maybeBroadcastPetPresence(overlayWindow)
  if (reevaluate) evaluatePetPresence(overlayWindow)
}

export function requestOverlayEdgeHover(
  overlayWindow: BrowserWindow | null,
  hovered: boolean
): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  if (appliedPetPresence !== 'EDGE') return

  overlayEdgeHovered = hovered
  evaluatePetPresence(overlayWindow)
}

let lastBroadcastPetPresence: PetPresencePayload | null = null

const PET_PRESENCE_CHANGED_CHANNEL = 'desktop-presence:changed'

function broadcastPetPresenceIfChanged(overlayWindow: BrowserWindow, payload: PetPresencePayload): void {
  if (!presencePayloadChanged(lastBroadcastPetPresence, payload)) return
  lastBroadcastPetPresence = payload
  overlayWindow.webContents.send(PET_PRESENCE_CHANGED_CHANNEL, payload)
}

function currentPetPresencePayload(): PetPresencePayload {
  const presence = appliedPetPresence ?? 'AMBIENT'
  return {
    presence,
    edgeSide: presence === 'EDGE' ? appliedPetEdgeSide : null,
    handleSuppressed: computeHandleSuppressed(latestPetDesired?.presence ?? presence, presence, appliedPetCollapsed),
    collapsed: appliedPetCollapsed,
    clickThrough: currentConfig().petClickThrough,
  }
}

function maybeBroadcastPetPresence(overlayWindow: BrowserWindow): void {
  broadcastPetPresenceIfChanged(overlayWindow, currentPetPresencePayload())
}

export function sendCurrentPetPresenceOnReady(overlayWindow: BrowserWindow | null): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return

  overlayEdgeHovered = false
  evaluatePetPresence(overlayWindow)

  if (lastBroadcastPetPresence === null) return
  overlayWindow.webContents.send(PET_PRESENCE_CHANGED_CHANNEL, lastBroadcastPetPresence)
}

const persistTimers = new Map<WindowKey, ReturnType<typeof setTimeout>>()

function appliedDisplayIdFor(windowKey: WindowKey): number | null {
  const recorded = windowKey === 'chat' ? appliedChatDisplayId : appliedPetDisplayId
  if (recorded === null) return recorded
  if (screen.getAllDisplays().some(display => display.id === recorded)) return recorded
  clearAppliedDisplayIdFor(windowKey)
  return null
}

function setAppliedDisplayIdFor(windowKey: WindowKey, displayId: number): void {
  if (windowKey === 'chat') appliedChatDisplayId = displayId
  else appliedPetDisplayId = displayId
}

function clearAppliedDisplayIdFor(windowKey: WindowKey): void {
  if (windowKey === 'chat') appliedChatDisplayId = null
  else appliedPetDisplayId = null
}

export function invalidateStaleAppliedDisplayIds(): void {
  appliedDisplayIdFor('overlay')
  appliedDisplayIdFor('chat')
}

function reconcileAfterDragPlacement(
  windowKey: WindowKey,
  mainWindow: BrowserWindow | null,
  overlayWindow: BrowserWindow | null
): void {
  revalidateBlockersNow({ forceConservative: true })
  endDragTail(windowKey)
  evaluateDesktopPresence(mainWindow, overlayWindow)
}

function persistBoundsNow(
  windowKey: WindowKey,
  win: BrowserWindow,
  mainWindow: BrowserWindow | null,
  overlayWindow: BrowserWindow | null
): void {
  if (isProgrammaticEchoFor(windowKey) && !isWindowDragInProgress(windowKey)) return

  const bounds = win.getBounds()
  const displays = screen.getAllDisplays()
  const dropDisplayId = screen.getDisplayMatching(bounds).id

  const effectiveHomeDisplayId = getEffectiveHomeDisplay(displays, windowKey).id
  const { currentDisplayId, temporaryRelocation } = deriveDragContext(
    appliedDisplayIdFor(windowKey),
    effectiveHomeDisplayId
  )

  const outcome = resolveDragOutcome(temporaryRelocation, currentDisplayId, dropDisplayId, getDisplayStateMap())

  if (outcome.kind === 'reject') {
    const rollback = lastValidPlacement.get(windowKey)
    if (rollback) {
      const { generation, onComplete } = beginProgrammaticMove(windowKey)
      const cancel = animateTo(win, rollback.bounds, () => {
        if (onComplete()) reconcileAfterDragPlacement(windowKey, mainWindow, overlayWindow)
      }, { instant: true, finalOpacity: targetOpacityFor(windowKey) })
      setActiveAnimationCancelIfCurrent(windowKey, generation, cancel)
    } else {
      moveToDisplay(win, windowKey, currentDisplayId, () =>
        reconcileAfterDragPlacement(windowKey, mainWindow, overlayWindow)
      )
    }
    return
  }

  commitHomeDisplayFromDragOutcome(windowKey, outcome)
  if (outcome.boundsWriteDisplayId !== null) {
    const boundsToWrite = windowKey === 'overlay' && appliedPetCollapsed
      ? expandedBoundsFromHandle(
          bounds,
          resolvePetSize(bounds, getPreferredBounds('overlay', outcome.boundsWriteDisplayId), true)
        )
      : bounds
    setPreferredBounds(windowKey, outcome.boundsWriteDisplayId, boundsToWrite)
  }
  notePlacement(windowKey, dropDisplayId, bounds)

  setAppliedDisplayIdFor(windowKey, dropDisplayId)

  reconcileAfterDragPlacement(windowKey, mainWindow, overlayWindow)
}

export function handleWindowMoved(
  windowKey: WindowKey,
  win: BrowserWindow,
  mainWindow: BrowserWindow | null,
  overlayWindow: BrowserWindow | null
): void {
  if (isProgrammaticEchoFor(windowKey) && !isWindowDragInProgress(windowKey)) return

  const pending = persistTimers.get(windowKey)
  if (pending) clearTimeout(pending)
  persistTimers.set(windowKey, setTimeout(() => {
    persistTimers.delete(windowKey)
    if (win.isDestroyed()) return
    persistBoundsNow(windowKey, win, mainWindow, overlayWindow)
  }, PERSIST_DEBOUNCE_MS))
}

export function applyOverlaySize(
  overlayWindow: BrowserWindow | null,
  size: { width: number; height: number }
): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return

  lastPetSize = { width: size.width, height: size.height }
  if (appliedPetCollapsed) return

  const current = overlayWindow.getBounds()
  if (current.width === size.width && current.height === size.height) return

  activeAnimationCancelFor.get('overlay')?.()

  const settled = overlayWindow.getBounds()
  const appliedDisplayId = appliedDisplayIdFor('overlay')
  const display =
    screen.getAllDisplays().find(candidate => candidate.id === appliedDisplayId) ?? screen.getDisplayMatching(settled)
  const remembered = getPreferredBounds('overlay', display.id) ?? settled
  const anchored = computeAnchoredResizeBounds(remembered, size, display.workArea)

  markProgrammaticQuiet('overlay', PROGRAMMATIC_MOVE_COOLDOWN_MS)
  overlayWindow.setBounds(
    appliedPetPresence === 'EDGE' ? { x: settled.x, y: anchored.y, width: size.width, height: size.height } : anchored
  )
  notePlacement('overlay', display.id, anchored)
  evaluatePetPresence(overlayWindow)
}

let lastPetSize: { width: number; height: number } | null = null
let appliedPetCollapsed = false

export function noteOverlayCreatedCollapsed(collapsed: boolean): void {
  appliedPetCollapsed = collapsed
}

function resolvePetSize(
  currentBounds: Electron.Rectangle,
  preferredBounds: Bounds | null,
  layoutCollapsed: boolean
): { width: number; height: number } {
  if (!layoutCollapsed) return { width: currentBounds.width, height: currentBounds.height }
  if (lastPetSize) return lastPetSize
  if (preferredBounds) return { width: preferredBounds.width, height: preferredBounds.height }
  return DEFAULT_WINDOW_SIZE.overlay
}

function syncPetCollapsedGeometry(win: BrowserWindow): void {
  const collapsed = currentConfig().petCollapsed
  if (collapsed === appliedPetCollapsed) return

  activeAnimationCancelFor.get('overlay')?.()
  if (collapsed === appliedPetCollapsed) return

  const settled = win.getBounds()
  const displays = screen.getAllDisplays()
  const appliedDisplayId = appliedDisplayIdFor('overlay')
  const display = displays.find(candidate => candidate.id === appliedDisplayId) ?? screen.getDisplayMatching(settled)
  const preferred = getPreferredBounds('overlay', display.id)
  const petSize = resolvePetSize(settled, preferred, appliedPetCollapsed)
  const expanded = preferred
    ? computeAnchoredResizeBounds(preferred, petSize, display.workArea)
    : computeDefaultBoundsForDisplay(display, displays, petSize, 'overlay')
  const target = collapsed ? collapsedHandleBounds(expanded) : expanded

  appliedPetCollapsed = collapsed
  markProgrammaticQuiet('overlay', PROGRAMMATIC_MOVE_COOLDOWN_MS)
  win.setBounds(target)
  win.setShape(collapsed ? [{ x: 0, y: 0, width: COLLAPSED_SIZE, height: COLLAPSED_SIZE }] : [])
  notePlacement('overlay', display.id, target)
}

let appliedIgnoreMouse = false

function applyPetInteractionMode(overlayWindow: BrowserWindow): void {
  const mode = getCurrentPetMode()

  const ignoreMouse = petModeIgnoresMouse(mode)
  if (ignoreMouse !== appliedIgnoreMouse) {
    if (ignoreMouse) overlayWindow.setIgnoreMouseEvents(true)
    else overlayWindow.setIgnoreMouseEvents(false)
    appliedIgnoreMouse = ignoreMouse
  }

  if (programmaticMoveInFlight.has('overlay')) return
  const opacity = petModeTargetOpacity(mode)
  if (overlayWindow.getOpacity() !== opacity) overlayWindow.setOpacity(opacity)
}

let applyingPetVisibility = false

function applyPetVisibility(overlayWindow: BrowserWindow, visibility: 'show' | 'hide' | null): void {
  if (applyingPetVisibility) return
  applyingPetVisibility = true
  try {
    if (visibility === 'show') overlayWindow.showInactive()
    else if (visibility === 'hide') overlayWindow.hide()
  } finally {
    applyingPetVisibility = false
  }
}

function evaluatePetPresence(overlayWindow: BrowserWindow | null): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  if (!startupGateOpen) return
  if (!windowBehaviorConfigSettled) return

  if (!isWindowDragInProgress('overlay')) syncPetCollapsedGeometry(overlayWindow)

  const displays = screen.getAllDisplays()
  const preferredDisplayId = getEffectiveHomeDisplay(displays, 'overlay').id
  const allDisplayIds = displays.map(display => display.id)
  const isInteracting = isWindowDragInProgress('overlay')
  const currentDisplayId = appliedDisplayIdFor('overlay') ?? preferredDisplayId
  const desired = resolvePetDesiredState(
    isInteracting,
    currentDisplayId,
    preferredDisplayId,
    getDisplayStateMap(),
    allDisplayIds,
    currentConfig().petAvoidanceEnabled
  )

  latestPetDesired = desired

  maybeBroadcastPetPresence(overlayWindow)

  const transition = diffPetState(desired, appliedDisplayIdFor('overlay'), overlayWindow.isVisible())
  applyPetVisibility(overlayWindow, transition.visibility)

  applyAlwaysOnTop(overlayWindow, 'overlay', desired.alwaysOnTop)

  applyPetInteractionMode(overlayWindow)

  if (petHandleWindow && !petHandleWindow.isDestroyed()) {
    const handleVisible = getCurrentPetMode() === 'clickThrough' && overlayWindow.isVisible()
    if (handleVisible) syncPetHandleBounds(petHandleWindow, overlayWindow)
    setPetHandleVisible(petHandleWindow, handleVisible)
  }

  if (transition.move !== null && !isInteracting) {
    appliedPetDisplayId = transition.move
    moveToDisplay(overlayWindow, 'overlay', transition.move, () => evaluatePetPresence(overlayWindow))
    return
  }

  runPetEdgeController(overlayWindow, desired, isInteracting)
}

function evaluateChatPresence(mainWindow: BrowserWindow | null): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) return
  if (!mainWindow.isVisible() && appliedChatPresence !== 'SUPPRESSED') return

  const { chatPinMode } = currentConfig()

  if (chatPinMode !== 'smart') {
    if (appliedChatPresence === 'SUPPRESSED') mainWindow.showInactive()
    applyAlwaysOnTop(mainWindow, 'chat', chatPinMode === 'always')
    appliedChatPresence = null
    appliedChatDisplayId = null
    return
  }

  const displays = screen.getAllDisplays()
  const preferredDisplayId = getEffectiveHomeDisplay(displays, 'chat').id
  const allDisplayIds = displays.map(display => display.id)
  const desired = resolveChatDesiredState(preferredDisplayId, getDisplayStateMap(), allDisplayIds)
  const transition = diffChatState(desired, appliedDisplayIdFor('chat'), mainWindow.isVisible())

  if (transition.move !== null && !isWindowDragInProgress('chat')) {
    moveToDisplay(mainWindow, 'chat', transition.move)
    appliedChatDisplayId = transition.move
  }
  applyAlwaysOnTop(mainWindow, 'chat', transition.alwaysOnTop)
  if (transition.visibility === 'show') mainWindow.showInactive()
  else if (transition.visibility === 'hide') mainWindow.hide()

  appliedChatPresence = desired.presence
}

export function evaluateDesktopPresence(mainWindow: BrowserWindow | null, overlayWindow: BrowserWindow | null): void {
  evaluatePetPresence(overlayWindow)
  evaluateChatPresence(mainWindow)
}
