import type { WindowKey } from './windowPositions'
import { PERSIST_DEBOUNCE_MS } from './windowPositions'

interface WindowDragState {
  isDragging: boolean
  dragStartedAt: number
  tailUntil: number
}

function makeInitialDragState(): WindowDragState {
  return { isDragging: false, dragStartedAt: 0, tailUntil: 0 }
}

const dragStates: Record<WindowKey, WindowDragState> = {
  overlay: makeInitialDragState(),
  chat: makeInitialDragState(),
}

export const DRAG_END_TAIL_MS = PERSIST_DEBOUNCE_MS + 150

export const MAX_DRAG_DURATION_MS = 60_000

export function noteDragStart(windowKey: WindowKey, now: number = Date.now()): void {
  const state = dragStates[windowKey]
  state.isDragging = true
  state.dragStartedAt = now
  state.tailUntil = 0
}

export function noteDragEnd(windowKey: WindowKey, now: number = Date.now()): void {
  const state = dragStates[windowKey]
  state.isDragging = false
  state.tailUntil = now + DRAG_END_TAIL_MS
}

export function isWindowDragInProgress(windowKey: WindowKey, now: number = Date.now()): boolean {
  const state = dragStates[windowKey]
  if (state.isDragging) {
    return now - state.dragStartedAt <= MAX_DRAG_DURATION_MS
  }
  return now < state.tailUntil
}

export function clearDragState(windowKey: WindowKey): void {
  dragStates[windowKey] = makeInitialDragState()
}

export function endDragTail(windowKey: WindowKey): void {
  const state = dragStates[windowKey]
  if (state.isDragging) return
  state.tailUntil = 0
}
