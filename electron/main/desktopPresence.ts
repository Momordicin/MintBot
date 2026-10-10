// electron/main/desktopPresence.ts — 桌宠与聊天窗口“桌面存在状态”的纯函数：由显示器阻挡表算出期望状态与状态差分，并含贴边几何、拖拽落点裁决
// 用法：windowBehavior.ts 调用 resolvePetDesiredState / resolveChatDesiredState / diffPetState / diffChatState / resolveDragOutcome / computeEdgeBounds 等
// 形状：PetPresence（ACTIVE/AMBIENT/EDGE/HIDDEN）、ChatPresence（SHOWN/NORMAL/SUPPRESSED）、DragOutcome（accept/reject）
// 对应文件：electron/main/windowBehavior.ts / electron/main/displayStateMap.ts（DisplayStateMap）/ electron/main/windowPositions.ts（Bounds）/ electron/main/homeDisplayCommit.ts（DragOutcome）/ electron/main/desktopPresence.test.ts
import type { DisplayStateMap } from './displayStateMap'
import type { Bounds } from './windowPositions'

export type PetPresence = 'ACTIVE' | 'AMBIENT' | 'EDGE' | 'HIDDEN'
export type ChatPresence = 'SHOWN' | 'NORMAL' | 'SUPPRESSED'

export type EdgeSide = 'left' | 'right'

export interface DesiredPetState {
  presence: PetPresence
  displayId: number
  alwaysOnTop: boolean
}

export interface DesiredChatState {
  presence: ChatPresence
  displayId: number
  alwaysOnTop: boolean
}

function pickFreeDisplay(allDisplayIds: readonly number[], excludeDisplayId: number, map: DisplayStateMap): number | null {
  let best: number | null = null
  for (const id of allDisplayIds) {
    if (id === excludeDisplayId || map.has(id)) continue
    if (best === null || id < best) best = id
  }
  return best
}

export function resolvePetDesiredState(
  isInteracting: boolean,
  currentDisplayId: number,
  preferredDisplayId: number,
  displayStateMap: DisplayStateMap,
  allDisplayIds: readonly number[],
  avoidanceEnabled: boolean = true
): DesiredPetState {
  if (isInteracting) {
    return { presence: 'ACTIVE', displayId: currentDisplayId, alwaysOnTop: true }
  }

  if (!avoidanceEnabled) {
    return { presence: 'AMBIENT', displayId: preferredDisplayId, alwaysOnTop: true }
  }

  if (!displayStateMap.has(preferredDisplayId)) {
    return { presence: 'AMBIENT', displayId: preferredDisplayId, alwaysOnTop: true }
  }

  const free = pickFreeDisplay(allDisplayIds, preferredDisplayId, displayStateMap)
  if (free !== null) {
    return { presence: 'AMBIENT', displayId: free, alwaysOnTop: true }
  }

  const severity = displayStateMap.get(preferredDisplayId)!.severity
  if (severity === 'soft') {
    return { presence: 'EDGE', displayId: preferredDisplayId, alwaysOnTop: true }
  }
  return { presence: 'HIDDEN', displayId: preferredDisplayId, alwaysOnTop: false }
}

export function resolveChatDesiredState(
  preferredDisplayId: number,
  displayStateMap: DisplayStateMap,
  allDisplayIds: readonly number[]
): DesiredChatState {
  const blocker = displayStateMap.get(preferredDisplayId)
  if (!blocker) {
    return { presence: 'SHOWN', displayId: preferredDisplayId, alwaysOnTop: true }
  }

  const free = pickFreeDisplay(allDisplayIds, preferredDisplayId, displayStateMap)
  if (free !== null) {
    return { presence: 'SHOWN', displayId: free, alwaysOnTop: true }
  }

  if (blocker.severity === 'soft') {
    return { presence: 'NORMAL', displayId: preferredDisplayId, alwaysOnTop: false }
  }
  return { presence: 'SUPPRESSED', displayId: preferredDisplayId, alwaysOnTop: false }
}

export interface PetTransition {
  move: number | null
  visibility: 'show' | 'hide' | null
}

const HIDDEN_PET_PRESENCES: ReadonlySet<PetPresence> = new Set(['HIDDEN'])

export function diffPetState(
  desired: DesiredPetState,
  appliedDisplayId: number | null,
  isCurrentlyVisible: boolean
): PetTransition {
  const desiredVisible = !HIDDEN_PET_PRESENCES.has(desired.presence)
  const skipMoveBecauseHiding = isCurrentlyVisible && !desiredVisible
  const move = !skipMoveBecauseHiding && desired.displayId !== appliedDisplayId ? desired.displayId : null

  let visibility: 'show' | 'hide' | null = null
  if (desiredVisible && !isCurrentlyVisible) visibility = 'show'
  else if (!desiredVisible && isCurrentlyVisible) visibility = 'hide'

  return { move, visibility }
}

export const EDGE_VISIBLE_SLIVER_PX = 40

export function resolveEdgeSide(petBounds: Bounds, displayBounds: Bounds): EdgeSide {
  const petCenterX = petBounds.x + petBounds.width / 2
  const displayCenterX = displayBounds.x + displayBounds.width / 2
  return petCenterX <= displayCenterX ? 'left' : 'right'
}

export function resolveStableEdgeSide(
  previousSide: EdgeSide | null,
  freshlyComputedSide: EdgeSide,
  episodeStillActive: boolean
): EdgeSide {
  if (episodeStillActive && previousSide !== null) return previousSide
  return freshlyComputedSide
}

export function computeEdgeBounds(
  currentBounds: Bounds,
  displayBounds: Bounds,
  side: EdgeSide,
  visibleSliverPx: number
): Bounds {
  const x =
    side === 'left'
      ? displayBounds.x - (currentBounds.width - visibleSliverPx)
      : displayBounds.x + displayBounds.width - visibleSliverPx
  return { x, y: currentBounds.y, width: currentBounds.width, height: currentBounds.height }
}

export function resolveEdgeHoverBounds(edgeBounds: Bounds, fullBounds: Bounds, hovered: boolean): Bounds {
  return hovered ? fullBounds : edgeBounds
}

export interface PetPresencePayload {
  presence: PetPresence
  edgeSide: EdgeSide | null
  handleSuppressed: boolean
}

export function computeHandleSuppressed(latestDesiredPresence: PetPresence, appliedPresence: PetPresence): boolean {
  return latestDesiredPresence === 'EDGE' || appliedPresence === 'EDGE'
}

export function presencePayloadChanged(previous: PetPresencePayload | null, next: PetPresencePayload): boolean {
  if (previous === null) return true
  return (
    previous.presence !== next.presence ||
    previous.edgeSide !== next.edgeSide ||
    previous.handleSuppressed !== next.handleSuppressed
  )
}

export interface ChatTransition {
  move: number | null
  alwaysOnTop: boolean
  visibility: 'show' | 'hide' | null
}

export function diffChatState(
  desired: DesiredChatState,
  appliedDisplayId: number | null,
  isCurrentlyVisible: boolean
): ChatTransition {
  const desiredVisible = desired.presence !== 'SUPPRESSED'
  const skipMoveBecauseHiding = isCurrentlyVisible && !desiredVisible
  const move = !skipMoveBecauseHiding && desired.displayId !== appliedDisplayId ? desired.displayId : null

  let visibility: 'show' | 'hide' | null = null
  if (desiredVisible && !isCurrentlyVisible) visibility = 'show'
  else if (!desiredVisible && isCurrentlyVisible) visibility = 'hide'

  return { move, alwaysOnTop: desired.alwaysOnTop, visibility }
}

export function canAcceptFullPlacement(displayId: number, map: DisplayStateMap): boolean {
  return !map.has(displayId)
}

export function deriveDragContext(
  appliedDisplayId: number | null,
  effectiveHomeDisplayId: number
): { currentDisplayId: number; temporaryRelocation: boolean } {
  const currentDisplayId = appliedDisplayId ?? effectiveHomeDisplayId
  return { currentDisplayId, temporaryRelocation: currentDisplayId !== effectiveHomeDisplayId }
}

export function extendQuietUntil(existingQuietUntil: number, now: number, ms: number): number {
  return Math.max(existingQuietUntil, now + ms)
}

export function isProgrammaticMoveEcho(inFlight: boolean, quietUntil: number, now: number): boolean {
  return inFlight || now < quietUntil
}

export function isTemporaryPlacement(displayId: number, effectiveHomeDisplayId: number): boolean {
  return displayId !== effectiveHomeDisplayId
}

export type DragOutcome =
  | { kind: 'accept'; newPreferredDisplayId: number | null; boundsWriteDisplayId: number | null }
  | { kind: 'reject' }

export function resolveDragOutcome(
  temporaryRelocation: boolean,
  currentDisplayId: number,
  dropDisplayId: number,
  displayStateMap: DisplayStateMap
): DragOutcome {
  if (!temporaryRelocation) {
    const droppedOnCurrentDisplay = dropDisplayId === currentDisplayId
    return {
      kind: 'accept',
      newPreferredDisplayId: droppedOnCurrentDisplay ? null : dropDisplayId,
      boundsWriteDisplayId: dropDisplayId,
    }
  }

  if (!canAcceptFullPlacement(dropDisplayId, displayStateMap)) {
    return { kind: 'reject' }
  }

  return { kind: 'accept', newPreferredDisplayId: null, boundsWriteDisplayId: dropDisplayId }
}
