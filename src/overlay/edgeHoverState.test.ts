import { describe, it, expect } from 'vitest'
import {
  INITIAL_EDGE_HOVER_STATE,
  EDGE_HOVER_LEAVE_DEBOUNCE_MS,
  onEdgeHoverEnter,
  onEdgeHoverLeave,
  onEdgeHoverDebounceElapsed,
  resetEdgeHoverOnPresenceLeftEdge,
  edgeHoverExpandedChanged,
  isDragHandleSuppressedByEdge,
  type EdgeHoverState,
} from './edgeHoverState.js'

describe('edgeHoverState: onEdgeHoverEnter', () => {
  it('expands immediately and clears any pending collapse', () => {
    const withPendingCollapse: EdgeHoverState = { expanded: true, pendingCollapseAt: 5000 }
    expect(onEdgeHoverEnter(withPendingCollapse)).toEqual({ expanded: true, pendingCollapseAt: null })
  })

  it('expands from the initial (collapsed) state', () => {
    expect(onEdgeHoverEnter(INITIAL_EDGE_HOVER_STATE)).toEqual({ expanded: true, pendingCollapseAt: null })
  })
})

describe('edgeHoverState: onEdgeHoverLeave', () => {
  it('does not collapse immediately — schedules an absolute collapse instant, expanded stays true', () => {
    const state: EdgeHoverState = { expanded: true, pendingCollapseAt: null }
    expect(onEdgeHoverLeave(state, 1000, 400)).toEqual({ expanded: true, pendingCollapseAt: 1400 })
  })
})

describe('edgeHoverState: onEdgeHoverDebounceElapsed', () => {
  it('collapses once the pending collapse instant has actually arrived', () => {
    const state: EdgeHoverState = { expanded: true, pendingCollapseAt: 1400 }
    expect(onEdgeHoverDebounceElapsed(state, 1400)).toEqual({ expanded: false, pendingCollapseAt: null })
  })

  it('does not collapse early — the debounce timer firing before the instant is a no-op', () => {
    const state: EdgeHoverState = { expanded: true, pendingCollapseAt: 1400 }
    expect(onEdgeHoverDebounceElapsed(state, 1399)).toEqual(state)
  })

  it('is a safe no-op when a later onEdgeHoverEnter already cancelled the pending collapse (a cursor grazing the sliver must not produce a burst of requests)', () => {
    const cancelled = onEdgeHoverEnter({ expanded: true, pendingCollapseAt: 1400 })
    // The stale timer set up by the earlier onEdgeHoverLeave still fires at 1400, but by then
    // pendingCollapseAt has already been cleared by the re-entry above.
    expect(onEdgeHoverDebounceElapsed(cancelled, 1400)).toEqual(cancelled)
  })
})

describe('edgeHoverState: resetEdgeHoverOnPresenceLeftEdge', () => {
  // Mandatory sanity check (i): if this is ever changed to ignore the "presence left EDGE"
  // reset (e.g. by making it a no-op that echoes back whatever state it was given), this
  // assertion must go RED.
  it('forces the state back to collapsed/no-pending regardless of what it was — expanded and mid-debounce', () => {
    expect(resetEdgeHoverOnPresenceLeftEdge()).toEqual(INITIAL_EDGE_HOVER_STATE)
  })

  it('is also a no-op-equivalent when already collapsed (idempotent)', () => {
    expect(resetEdgeHoverOnPresenceLeftEdge()).toEqual(INITIAL_EDGE_HOVER_STATE)
  })
})

describe('edgeHoverState: edgeHoverExpandedChanged (gate for notifying main — no request burst)', () => {
  it('is false when expanded is unchanged (e.g. a leave immediately re-cancelled by an enter)', () => {
    const before: EdgeHoverState = { expanded: true, pendingCollapseAt: null }
    const afterLeaveThenEnter = onEdgeHoverEnter(onEdgeHoverLeave(before, 1000, EDGE_HOVER_LEAVE_DEBOUNCE_MS))
    expect(edgeHoverExpandedChanged(before, afterLeaveThenEnter)).toBe(false)
  })

  it('is true on a genuine enter from collapsed', () => {
    const next = onEdgeHoverEnter(INITIAL_EDGE_HOVER_STATE)
    expect(edgeHoverExpandedChanged(INITIAL_EDGE_HOVER_STATE, next)).toBe(true)
  })

  it('is true on a genuine collapse once the debounce elapses', () => {
    const expanded: EdgeHoverState = { expanded: true, pendingCollapseAt: 1400 }
    const collapsed = onEdgeHoverDebounceElapsed(expanded, 1400)
    expect(edgeHoverExpandedChanged(expanded, collapsed)).toBe(true)
  })
})

describe('edgeHoverState: isDragHandleSuppressedByEdge (FIX 1 — the drag handle sits inside the edge sliver and kills hover; third rework — main now computes the safety gate)', () => {
  // Mandatory sanity check (i): if this is ever changed to unconditionally report "handle
  // shown/draggable" (e.g. by always returning false), this assertion must go RED.
  it('suppresses the handle while main reports handleSuppressed and it is not yet hover-expanded — this is exactly the dead-zone case', () => {
    expect(isDragHandleSuppressedByEdge(true, false)).toBe(true)
  })

  it('stops suppressing once hover has expanded the window back to full bounds, even while main still reports handleSuppressed', () => {
    expect(isDragHandleSuppressedByEdge(true, true)).toBe(false)
  })

  it('never suppresses when main reports handleSuppressed = false, regardless of the (meaningless there) edgeExpanded flag', () => {
    expect(isDragHandleSuppressedByEdge(false, false)).toBe(false)
    expect(isDragHandleSuppressedByEdge(false, true)).toBe(false)
  })
})
