import { describe, it, expect, beforeEach } from 'vitest'
import {
  noteDragStart,
  noteDragEnd,
  isWindowDragInProgress,
  isAnyDragInProgress,
  clearDragState,
  endDragTail,
  DRAG_END_TAIL_MS,
  MAX_DRAG_DURATION_MS,
} from './dragActivity'
import { PERSIST_DEBOUNCE_MS } from './windowPositions'

// Stage 3: drag state is now driven by the authoritative WM_ENTERSIZEMOVE/WM_EXITSIZEMOVE pair
// (electron/main/windowDragMonitor.ts calls noteDragStart/noteDragEnd) instead of a "time since
// the last 'moved' event" heuristic. These tests drive the state machine directly through
// noteDragStart/noteDragEnd with injected `now` values for the tail — the real WM message
// delivery itself has zero logic to test (windowDragMonitor.ts's two hookWindowMessage callbacks
// are pure forwarding, see that file's header comment).
//
// Fix 1 (second rework pass): state is now per-window (WindowKey), not a single module-level
// flag — see dragActivity.ts's header comment for why. Module state (both windows) is shared
// across tests in this file — beforeEach resets both to "no drag, no tail" via clearDragState so
// no test's leftover tail/ceiling state can bleed into the next one.

beforeEach(() => {
  clearDragState('overlay')
  clearDragState('chat')
})

describe('dragActivity — per-window state (isWindowDragInProgress)', () => {
  it('is not in progress once a drag has ended and its tail has fully elapsed', () => {
    noteDragStart('overlay')
    noteDragEnd('overlay', 0)
    expect(isWindowDragInProgress('overlay', DRAG_END_TAIL_MS)).toBe(false)
  })

  it('is in progress immediately after WM_ENTERSIZEMOVE, before any WM_EXITSIZEMOVE', () => {
    noteDragStart('overlay')
    expect(isWindowDragInProgress('overlay')).toBe(true)
  })

  it('stays in progress through the tail right after WM_EXITSIZEMOVE, and drops out exactly once the tail elapses', () => {
    noteDragStart('overlay')
    noteDragEnd('overlay', 1000)
    expect(isWindowDragInProgress('overlay', 1000 + DRAG_END_TAIL_MS - 1)).toBe(true)
    expect(isWindowDragInProgress('overlay', 1000 + DRAG_END_TAIL_MS)).toBe(false)
  })

  it('a fresh WM_ENTERSIZEMOVE clears a stale tail left over from the previous drag, rather than extending it', () => {
    noteDragStart('overlay', 0)
    noteDragEnd('overlay', 100) // stale tail would expire at 100 + DRAG_END_TAIL_MS
    noteDragStart('overlay', 100) // re-armed before that tail expired — the stale tail must no longer apply
    noteDragEnd('overlay', 60) // a new, earlier tail: expires at 60 + DRAG_END_TAIL_MS
    expect(isWindowDragInProgress('overlay', 60 + DRAG_END_TAIL_MS)).toBe(false)
  })

  // Fix 1: the core requirement of the per-window split — each window's state is completely
  // independent of the other's. This is what evaluatePetPresence's isInteracting and
  // evaluateChatPresence's move-skip guard each rely on (see windowBehavior.ts call sites).
  it("a chat drag does not affect the overlay window's drag state, and vice versa", () => {
    noteDragStart('chat', 0)
    expect(isWindowDragInProgress('overlay', 0)).toBe(false)
    expect(isWindowDragInProgress('chat', 0)).toBe(true)

    noteDragStart('overlay', 0)
    expect(isWindowDragInProgress('overlay', 0)).toBe(true)
    expect(isWindowDragInProgress('chat', 0)).toBe(true) // still true, unaffected by overlay's start

    noteDragEnd('overlay', 0)
    expect(isWindowDragInProgress('overlay', DRAG_END_TAIL_MS)).toBe(false)
    expect(isWindowDragInProgress('chat', DRAG_END_TAIL_MS)).toBe(true) // chat's own drag is untouched
  })
})

describe('dragActivity — isAnyDragInProgress (the one deliberately global signal, for selectValidationMode)', () => {
  it('is true when only the overlay window is mid-drag', () => {
    noteDragStart('overlay', 0)
    expect(isAnyDragInProgress(0)).toBe(true)
  })

  it('is true when only the chat window is mid-drag', () => {
    noteDragStart('chat', 0)
    expect(isAnyDragInProgress(0)).toBe(true)
  })

  it('is false when neither window is dragging or in its tail', () => {
    noteDragStart('overlay', 0)
    noteDragEnd('overlay', 0)
    noteDragStart('chat', 0)
    noteDragEnd('chat', 0)
    expect(isAnyDragInProgress(DRAG_END_TAIL_MS)).toBe(false)
  })
})

describe('dragActivity — Fix 2 (bounded recovery: a stuck isDragging must self-heal)', () => {
  it('a start with no matching end self-heals once MAX_DRAG_DURATION_MS elapses', () => {
    noteDragStart('overlay', 0)
    expect(isWindowDragInProgress('overlay', MAX_DRAG_DURATION_MS)).toBe(true)
    expect(isWindowDragInProgress('overlay', MAX_DRAG_DURATION_MS + 1)).toBe(false)
  })

  it('the ceiling is per-window — a stuck overlay drag does not affect the chat window, and vice versa', () => {
    noteDragStart('overlay', 0)
    noteDragStart('chat', 0)
    noteDragEnd('chat', 10) // chat ends normally, well before the ceiling
    expect(isWindowDragInProgress('chat', MAX_DRAG_DURATION_MS + 1)).toBe(false) // via its own tail, not the ceiling
    expect(isWindowDragInProgress('overlay', MAX_DRAG_DURATION_MS)).toBe(true) // overlay is still stuck (pre-ceiling)
    expect(isWindowDragInProgress('overlay', MAX_DRAG_DURATION_MS + 1)).toBe(false) // self-heals at the ceiling
  })

  it('clearDragState resets a window to "no drag, no tail" immediately, for the lock-screen/unlock-screen and window-destroyed recovery paths', () => {
    noteDragStart('overlay', 0)
    clearDragState('overlay')
    expect(isWindowDragInProgress('overlay', 0)).toBe(false)
    // and it does not open a tail either — a cleared drag is not treated as a just-ended one
    expect(isWindowDragInProgress('overlay', 1)).toBe(false)
  })

  it('clearDragState only affects the window it is called for', () => {
    noteDragStart('overlay', 0)
    noteDragStart('chat', 0)
    clearDragState('overlay')
    expect(isWindowDragInProgress('overlay', 0)).toBe(false)
    expect(isWindowDragInProgress('chat', 0)).toBe(true)
  })
})

describe('dragActivity — Fix 4 (DRAG_END_TAIL_MS derives from the single shared PERSIST_DEBOUNCE_MS)', () => {
  // The mandatory sanity check for this rework pass requires reverting Fix 4 (reintroducing a
  // divergent local copy of PERSIST_DEBOUNCE_MS in this file) to turn a test RED. This is that
  // test: it compares DRAG_END_TAIL_MS's actual value against windowPositions.ts's exported
  // constant directly, rather than against a hardcoded number — a local, divergent copy here
  // would change DRAG_END_TAIL_MS without changing what this test expects, and the assertion
  // would fail.
  it("derives DRAG_END_TAIL_MS from windowPositions.ts's PERSIST_DEBOUNCE_MS, not a local copy", () => {
    expect(DRAG_END_TAIL_MS).toBe(PERSIST_DEBOUNCE_MS + 150)
  })
})

describe('endDragTail', () => {
  it('收掉松手尾巴，使 isWindowDragInProgress 立刻变为假', () => {
    noteDragStart('overlay', 1000)
    noteDragEnd('overlay', 2000)
    expect(isWindowDragInProgress('overlay', 2100)).toBe(true)

    endDragTail('overlay')

    expect(isWindowDragInProgress('overlay', 2100)).toBe(false)
  })

  it('拖拽仍在进行时是 no-op——落盘防抖到期时用户可能已经重新抓住窗口', () => {
    noteDragStart('overlay', 1000)
    noteDragEnd('overlay', 2000)
    // 上一段拖拽的落盘防抖还没到期，用户又抓住了窗口
    noteDragStart('overlay', 2200)

    // 这次调用属于上一段拖拽，不能把新拖拽的 isDragging 清掉
    endDragTail('overlay')

    expect(isWindowDragInProgress('overlay', 2300)).toBe(true)
  })

  it('只影响传入的那个窗口', () => {
    noteDragStart('chat', 1000)
    noteDragEnd('chat', 2000)

    endDragTail('overlay')

    expect(isWindowDragInProgress('chat', 2100)).toBe(true)
  })
})
