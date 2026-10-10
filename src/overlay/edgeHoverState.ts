// src/overlay/edgeHoverState.ts — 桌宠贴边（EDGE）时悬停展开/延迟收起的纯状态函数
// 用法：OverlayApp 调用 onEdgeHoverEnter / onEdgeHoverLeave / onEdgeHoverDebounceElapsed / resetEdgeHoverOnPresenceLeftEdge / edgeHoverExpandedChanged / isDragHandleSuppressedByEdge
// 形状：EdgeHoverState { expanded, pendingCollapseAt }
// 对应文件：src/overlay/OverlayApp.tsx / src/overlay/edgeHoverState.test.ts

export interface EdgeHoverState {
  expanded: boolean
  pendingCollapseAt: number | null
}

export const INITIAL_EDGE_HOVER_STATE: EdgeHoverState = { expanded: false, pendingCollapseAt: null }

export const EDGE_HOVER_LEAVE_DEBOUNCE_MS = 400

export function onEdgeHoverEnter(_previous: EdgeHoverState): EdgeHoverState {
  return { expanded: true, pendingCollapseAt: null }
}

export function onEdgeHoverLeave(previous: EdgeHoverState, now: number, debounceMs: number): EdgeHoverState {
  return { ...previous, pendingCollapseAt: now + debounceMs }
}

export function onEdgeHoverDebounceElapsed(state: EdgeHoverState, now: number): EdgeHoverState {
  if (state.pendingCollapseAt === null) return state
  if (now < state.pendingCollapseAt) return state
  return { expanded: false, pendingCollapseAt: null }
}

export function resetEdgeHoverOnPresenceLeftEdge(): EdgeHoverState {
  return INITIAL_EDGE_HOVER_STATE
}

export function edgeHoverExpandedChanged(previous: EdgeHoverState, next: EdgeHoverState): boolean {
  return previous.expanded !== next.expanded
}

export function isDragHandleSuppressedByEdge(mainHandleSuppressed: boolean, edgeExpanded: boolean): boolean {
  return mainHandleSuppressed && !edgeExpanded
}
