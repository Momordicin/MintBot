import { describe, it, expect } from 'vitest'
import {
  resolvePetDesiredState,
  resolveChatDesiredState,
  diffPetState,
  diffChatState,
  resolveDragOutcome,
  canAcceptFullPlacement,
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
} from './desktopPresence'
import type { DisplayStateMap, DisplayBlocker } from './displayStateMap'

// 只测本文件（desktopPresence.ts）里的纯函数——真正把这些返回值套用到 BrowserWindow 的
// 编排逻辑在 windowBehavior.ts，依赖真实 Electron 运行时，不在这里测（跟
// windowBehavior.test.ts/windowPositions.test.ts"只测纯函数"同一个约定）

function makeBlocker(overrides: Partial<DisplayBlocker> = {}): DisplayBlocker {
  return {
    hwnd: 1n,
    pid: 111,
    exeName: 'game.exe',
    displayId: 1,
    reasons: new Set(['fullscreen']),
    severity: 'hard',
    ...overrides,
  }
}

function makeMap(entries: Array<[number, Partial<DisplayBlocker>]>): DisplayStateMap {
  const map: DisplayStateMap = new Map()
  for (const [displayId, overrides] of entries) {
    map.set(displayId, makeBlocker({ displayId, ...overrides }))
  }
  return map
}

// Stage 3 起 resolvePetDesiredState 多了两个前置参数（isInteracting, currentDisplayId）。这
// 组不涉及交互的既有测试全部传 isInteracting = false；currentDisplayId 在这些测试里不参与
// 任何被断言的分支（只有 isInteracting = true 时才会被读取），传一个跟 preferredDisplayId
// 无关的哨兵值（999）以确保这一点——如果它意外被某个非交互分支读取，这些测试会立刻暴露出来
const NOT_INTERACTING = false
const UNUSED_CURRENT_DISPLAY_ID = 999

describe('resolvePetDesiredState', () => {
  it('stays AMBIENT at home when home has no blocker', () => {
    const map = makeMap([])
    expect(resolvePetDesiredState(NOT_INTERACTING, UNUSED_CURRENT_DISPLAY_ID, 1, map, [1, 2])).toEqual({ presence: 'AMBIENT', displayId: 1, alwaysOnTop: true })
  })

  it('relocates to the free display, AMBIENT, when home is blocked', () => {
    const map = makeMap([[1, {}]])
    expect(resolvePetDesiredState(NOT_INTERACTING, UNUSED_CURRENT_DISPLAY_ID, 1, map, [1, 2])).toEqual({ presence: 'AMBIENT', displayId: 2, alwaysOnTop: true })
  })

  it('picks the lowest-id free display deterministically when several are free', () => {
    const map = makeMap([[1, {}]])
    expect(resolvePetDesiredState(NOT_INTERACTING, UNUSED_CURRENT_DISPLAY_ID, 1, map, [1, 3, 2])).toEqual({ presence: 'AMBIENT', displayId: 2, alwaysOnTop: true })
  })

  it('goes HIDDEN when every display is blocked, hard severity (multi-display-blocked scenario)', () => {
    const map = makeMap([
      [1, {}],
      [2, {}],
      [3, {}],
    ])
    expect(resolvePetDesiredState(NOT_INTERACTING, UNUSED_CURRENT_DISPLAY_ID, 1, map, [1, 2, 3])).toEqual({ presence: 'HIDDEN', displayId: 1, alwaysOnTop: false })
  })

  it('goes HIDDEN on a single display with no other screen to relocate to, hard severity', () => {
    const map = makeMap([[1, {}]])
    expect(resolvePetDesiredState(NOT_INTERACTING, UNUSED_CURRENT_DISPLAY_ID, 1, map, [1])).toEqual({ presence: 'HIDDEN', displayId: 1, alwaysOnTop: false })
  })

  // Stage 3: the "nowhere to go" branch now reads the home blocker's severity instead of
  // collapsing to HIDDEN unconditionally. EDGE is unreachable end-to-end today (displayStateMap.ts's
  // REASON_SEVERITY maps every current reason to 'hard' — Stage 4 introduces a genuine soft
  // reason), so this is tested directly at the resolver level, the same way this file already
  // tests resolveChatDesiredState's 'soft' branch (see that describe block's own comment).
  it('goes EDGE (not HIDDEN) when there is nowhere to go and the home blocker is soft', () => {
    const map = makeMap([[1, { severity: 'soft' }]])
    expect(resolvePetDesiredState(NOT_INTERACTING, UNUSED_CURRENT_DISPLAY_ID, 1, map, [1])).toEqual({ presence: 'EDGE', displayId: 1, alwaysOnTop: true })
  })

  it('goes HIDDEN (not EDGE) when there is nowhere to go and the home blocker is hard', () => {
    const map = makeMap([[1, { severity: 'hard' }]])
    expect(resolvePetDesiredState(NOT_INTERACTING, UNUSED_CURRENT_DISPLAY_ID, 1, map, [1])).toEqual({ presence: 'HIDDEN', displayId: 1, alwaysOnTop: false })
  })

  // "已确认的推论"（TDD 原文）：用户在避难期间把小人拖到 D，A 的冲突一旦解除，它仍会飞回 A——
  // 这里直接验证其结构性原因：resolver（在不交互时）完全不吃"当前实际所在显示器"这个参数，
  // 只吃 preferredDisplayId + 当前 blocker 状态，所以无论上一次实际停在哪，一旦 home 空出来，
  // 下一次 resolve 恒定重新指向 home
  it('always re-derives from home, independent of wherever it was last relocated to (drag-to-D-then-conflict-ends still returns home)', () => {
    const blockedAtHome = makeMap([[1, {}]])
    const relocated = resolvePetDesiredState(NOT_INTERACTING, UNUSED_CURRENT_DISPLAY_ID, 1, blockedAtHome, [1, 2])
    expect(relocated).toEqual({ presence: 'AMBIENT', displayId: 2, alwaysOnTop: true })

    // 冲突解除——不管上一次实际停在哪块屏（哪怕用户手动把它拖去了 D=2 之外的第三块屏），
    // resolver 这一次拿到的输入里根本没有那个信息，只会看 home 现在是否空闲
    const cleared = resolvePetDesiredState(NOT_INTERACTING, UNUSED_CURRENT_DISPLAY_ID, 1, makeMap([]), [1, 2, 3])
    expect(cleared).toEqual({ presence: 'AMBIENT', displayId: 1, alwaysOnTop: true })
  })

  it('relocates away from a display that becomes blocked mid-relocation, independent of which other display was previously free', () => {
    // 多屏同时各自独立 blocked 的场景：home(1) 与曾经的避难屏(2) 现在都被挡住，3 空闲
    const map = makeMap([
      [1, {}],
      [2, {}],
    ])
    expect(resolvePetDesiredState(NOT_INTERACTING, UNUSED_CURRENT_DISPLAY_ID, 1, map, [1, 2, 3])).toEqual({ presence: 'AMBIENT', displayId: 3, alwaysOnTop: true })
  })
})

describe('resolvePetDesiredState — ACTIVE (interacting)', () => {
  it('is ACTIVE, reporting currentDisplayId, when interacting — even though home has no blocker', () => {
    const map = makeMap([])
    expect(resolvePetDesiredState(true, 1, 1, map, [1, 2])).toEqual({ presence: 'ACTIVE', displayId: 1, alwaysOnTop: true })
  })

  // The core requirement this branch exists for: interacting pre-empts every other branch,
  // including "nowhere to go, hard severity" which would otherwise be HIDDEN — a hard blocker on
  // home must not hide the character out from under the user's hand while they're holding it.
  it('is ACTIVE even when every display is hard-blocked (interacting pre-empts severity entirely)', () => {
    const map = makeMap([
      [1, {}],
      [2, {}],
    ])
    expect(resolvePetDesiredState(true, 2, 1, map, [1, 2])).toEqual({ presence: 'ACTIVE', displayId: 2, alwaysOnTop: true })
  })

  // displayId must be currentDisplayId (where the pet actually is right now), not
  // preferredDisplayId and not a relocate target — this is what makes diffPetState produce no
  // move while the user is holding the window (see resolvePetDesiredState's own comment on this).
  it('reports currentDisplayId, not preferredDisplayId, while interacting on a display other than home', () => {
    const map = makeMap([[1, {}]]) // home (1) blocked, pet is currently parked on refuge display 2
    const desired = resolvePetDesiredState(true, 2, 1, map, [1, 2])
    expect(desired).toEqual({ presence: 'ACTIVE', displayId: 2, alwaysOnTop: true })
    // and feeding this straight into diffPetState against the same appliedDisplayId (2) produces
    // no move, which is the actual behavioural requirement this branch exists to satisfy
    expect(diffPetState(desired, 2, true, false).move).toBeNull()
  })

  // Fix 6（second rework pass）: the guarantee above only holds when currentDisplayId itself
  // reflects reality. The caller (windowBehavior.ts) computes it as
  // `appliedDisplayIdFor('overlay') ?? preferredDisplayId` — if the overlay's display was
  // disconnected mid-interaction, appliedDisplayIdFor returns null (Stage 2 Fix C) and this falls
  // back to home, which may not be where the window physically still is. Nothing in this pure
  // layer stops diffPetState from computing a real move out of that mismatch — the
  // `transition.move !== null && !isInteracting` guard in windowBehavior.ts is what must suppress
  // it (pinned by an integration-level test in windowBehavior.test.ts, since reproducing the
  // appliedDisplayId invalidation itself requires that file's mocked screen/BrowserWindow).
  it('produces a non-null move when currentDisplayId (ACTIVE, home fallback) differs from the previously applied display — the caller must suppress this, not this function', () => {
    const map = makeMap([[1, {}]])
    const desired = resolvePetDesiredState(true, 1, 1, map, [1])
    expect(desired).toEqual({ presence: 'ACTIVE', displayId: 1, alwaysOnTop: true })
    expect(diffPetState(desired, null, false, false).move).toBe(1)
  })
})

describe('resolvePetDesiredState — petAvoidanceEnabled = false (Stage 4 "exit custody, then stop the policy")', () => {
  // Mandatory sanity check (i): if avoidanceEnabled=false is implemented as "set the flag and
  // return" without falling through the ordinary resolver, this pure-function property is what
  // must go RED first — the whole point is that turning avoidance off is an ordinary desired-state
  // change (AMBIENT @ home), not a bespoke imperative restore path.
  it('is AMBIENT at home, completely ignoring a hard blocker on home', () => {
    const map = makeMap([[1, { severity: 'hard' }]])
    expect(resolvePetDesiredState(NOT_INTERACTING, UNUSED_CURRENT_DISPLAY_ID, 1, map, [1], false)).toEqual({
      presence: 'AMBIENT',
      displayId: 1,
      alwaysOnTop: true,
    })
  })

  it('is AMBIENT at home, completely ignoring a soft blocker on home', () => {
    const map = makeMap([[1, { severity: 'soft' }]])
    expect(resolvePetDesiredState(NOT_INTERACTING, UNUSED_CURRENT_DISPLAY_ID, 1, map, [1], false)).toEqual({
      presence: 'AMBIENT',
      displayId: 1,
      alwaysOnTop: true,
    })
  })

  it('is AMBIENT at home even when every display is blocked and another display would otherwise be free', () => {
    const map = makeMap([
      [1, {}],
      [2, {}],
    ])
    expect(resolvePetDesiredState(NOT_INTERACTING, UNUSED_CURRENT_DISPLAY_ID, 1, map, [1, 2], false)).toEqual({
      presence: 'AMBIENT',
      displayId: 1,
      alwaysOnTop: true,
    })
  })

  // Negative case (REQUIRED by the task spec): once avoidance is off, further blocker changes must
  // not move it away from home at all — there is no branch here that reads displayStateMap once
  // avoidanceEnabled is false, so this is guaranteed by construction, not by re-checking each time.
  it('stays at home regardless of which displays are blocked (no branch here ever reads the blocker map)', () => {
    const noBlockers = resolvePetDesiredState(NOT_INTERACTING, UNUSED_CURRENT_DISPLAY_ID, 1, makeMap([]), [1, 2], false)
    const allBlocked = resolvePetDesiredState(NOT_INTERACTING, UNUSED_CURRENT_DISPLAY_ID, 1, makeMap([[1, {}], [2, {}]]), [1, 2], false)
    expect(noBlockers).toEqual({ presence: 'AMBIENT', displayId: 1, alwaysOnTop: true })
    expect(allBlocked).toEqual({ presence: 'AMBIENT', displayId: 1, alwaysOnTop: true })
  })

  it('interacting still pre-empts avoidance being disabled — dragging is orthogonal to avoidance', () => {
    const map = makeMap([[1, {}]])
    expect(resolvePetDesiredState(true, 1, 1, map, [1], false)).toEqual({ presence: 'ACTIVE', displayId: 1, alwaysOnTop: true })
  })

  it('defaults avoidanceEnabled to true when the argument is omitted (behaviour-preserving default)', () => {
    const map = makeMap([[1, {}]])
    // Same call as the very first describe block's "goes HIDDEN" test, just omitting the last arg.
    expect(resolvePetDesiredState(NOT_INTERACTING, UNUSED_CURRENT_DISPLAY_ID, 1, map, [1])).toEqual({
      presence: 'HIDDEN',
      displayId: 1,
      alwaysOnTop: false,
    })
  })
})

describe('resolveChatDesiredState', () => {
  it('stays SHOWN at home when home has no blocker', () => {
    expect(resolveChatDesiredState(1, makeMap([]), [1, 2])).toEqual({ presence: 'SHOWN', displayId: 1, alwaysOnTop: true })
  })

  it('relocates to the free display, SHOWN, when home is blocked', () => {
    const map = makeMap([[1, {}]])
    expect(resolveChatDesiredState(1, map, [1, 2])).toEqual({ presence: 'SHOWN', displayId: 2, alwaysOnTop: true })
  })

  it('drops to NORMAL (no relocate target, soft blocker) — lets the foreground app cover it', () => {
    const map = makeMap([[1, { severity: 'soft' }]])
    expect(resolveChatDesiredState(1, map, [1])).toEqual({ presence: 'NORMAL', displayId: 1, alwaysOnTop: false })
  })

  it('goes SUPPRESSED (no relocate target, hard blocker)', () => {
    const map = makeMap([[1, { severity: 'hard' }]])
    expect(resolveChatDesiredState(1, map, [1])).toEqual({ presence: 'SUPPRESSED', displayId: 1, alwaysOnTop: false })
  })

  it('multi-display-blocked: only relocates to a display that is itself free', () => {
    const map = makeMap([
      [1, {}],
      [2, {}],
    ])
    expect(resolveChatDesiredState(1, map, [1, 2, 3])).toEqual({ presence: 'SHOWN', displayId: 3, alwaysOnTop: true })
  })
})

describe('diffPetState', () => {
  it('produces no side effects when the desired state is unchanged from applied (idempotency requirement)', () => {
    const desired = { presence: 'AMBIENT' as const, displayId: 1, alwaysOnTop: true }
    expect(diffPetState(desired, 1, true, false)).toEqual({ move: null, visibility: null })
  })

  it('moves and shows on first-ever resolve (appliedDisplayId null, currently hidden)', () => {
    const desired = { presence: 'AMBIENT' as const, displayId: 1, alwaysOnTop: true }
    expect(diffPetState(desired, null, false, false)).toEqual({ move: 1, visibility: 'show' })
  })

  it('suppresses the show while chat is focused, but still tracks the move', () => {
    const desired = { presence: 'AMBIENT' as const, displayId: 2, alwaysOnTop: true }
    expect(diffPetState(desired, 1, false, true)).toEqual({ move: 2, visibility: null })
  })

  it('hides without moving when transitioning to HIDDEN while currently visible on a different display', () => {
    const desired = { presence: 'HIDDEN' as const, displayId: 1, alwaysOnTop: false }
    expect(diffPetState(desired, 2, true, false)).toEqual({ move: null, visibility: 'hide' })
  })

  it('still moves while already hidden (pre-positions it for the next reveal)', () => {
    const desired = { presence: 'HIDDEN' as const, displayId: 1, alwaysOnTop: false }
    expect(diffPetState(desired, 2, false, false)).toEqual({ move: 1, visibility: null })
  })

  // Stage 3: ACTIVE and EDGE are both visible, exactly like AMBIENT (see diffPetState's
  // HIDDEN_PET_PRESENCES comment — visibility is "everything except HIDDEN", not
  // `=== 'AMBIENT'`). These two guard against silently regressing back to the old hardcoded
  // comparison, which would have judged both of these as invisible.
  it('shows on first reveal when desired is ACTIVE (not just AMBIENT)', () => {
    const desired = { presence: 'ACTIVE' as const, displayId: 1, alwaysOnTop: true }
    expect(diffPetState(desired, null, false, false)).toEqual({ move: 1, visibility: 'show' })
  })

  it('shows on first reveal when desired is EDGE (not just AMBIENT)', () => {
    const desired = { presence: 'EDGE' as const, displayId: 1, alwaysOnTop: true }
    expect(diffPetState(desired, null, false, false)).toEqual({ move: 1, visibility: 'show' })
  })

  // Fix 4（cleanup sweep）：electron/main/windowBehavior.ts's applyingPetVisibility reentrancy
  // guard (see its own definition-site comment) is safe today only because hide() is the only one
  // of the four interrupt listeners that path can trigger, and hide only ever happens together
  // with move === null — never with a real relocate still pending. That "hide and move are
  // mutually exclusive" property lives entirely in skipMoveBecauseHiding below; it was previously
  // guaranteed only by a comment, not by anything the compiler or a test would break if it ever
  // stopped being true. This test pins the property directly, by exhausting the realistic input
  // space, instead of relying on that comment being kept accurate by hand. If diffPetState is ever
  // changed to allow visibility: 'hide' together with a non-null move, this test — not the
  // reentrancy guard's silent assumption — is what goes red first.
  describe('hide and move are mutually exclusive (reentrancy guard invariant, Fix 4)', () => {
    const presences = ['ACTIVE', 'AMBIENT', 'EDGE', 'HIDDEN'] as const
    const displayIds = [1, 2, 3]
    const appliedDisplayIds = [null, 1, 2, 3]
    const bools = [true, false]

    it('never produces move !== null together with visibility === "hide", across the full input space', () => {
      for (const presence of presences) {
        for (const displayId of displayIds) {
          for (const appliedDisplayId of appliedDisplayIds) {
            for (const isCurrentlyVisible of bools) {
              for (const chatFocused of bools) {
                const transition = diffPetState({ presence, displayId, alwaysOnTop: presence !== 'HIDDEN' }, appliedDisplayId, isCurrentlyVisible, chatFocused)
                if (transition.visibility === 'hide') {
                  expect(transition.move).toBeNull()
                }
              }
            }
          }
        }
      }
    })
  })
})

describe('resolveEdgeSide', () => {
  const display = { x: 0, y: 0, width: 1920, height: 1080 }

  it('picks left when the pet is nearer the left edge', () => {
    const pet = { x: 0, y: 100, width: 132, height: 132 }
    expect(resolveEdgeSide(pet, display)).toBe('left')
  })

  it('picks right when the pet is nearer the right edge', () => {
    const pet = { x: 1920 - 132, y: 100, width: 132, height: 132 }
    expect(resolveEdgeSide(pet, display)).toBe('right')
  })

  // Exact-centre tie: documented, deterministic, fixed choice of 'left' — see the function's own
  // comment for why 'left' specifically (arbitrary, but must not vary between calls).
  it('picks left deterministically on an exact center tie', () => {
    const pet = { x: 1920 / 2 - 132 / 2, y: 100, width: 132, height: 132 }
    expect(resolveEdgeSide(pet, display)).toBe('left')
    expect(resolveEdgeSide(pet, display)).toBe('left') // repeat call: must not flip
  })

  // Off-by-origin guard: a secondary monitor's physical bounds do not start at (0, 0).
  it('accounts for a non-zero display origin (secondary monitor) rather than assuming (0, 0)', () => {
    const secondaryDisplay = { x: 1920, y: 0, width: 1920, height: 1080 }
    const petNearItsLeftEdge = { x: 1920, y: 100, width: 132, height: 132 }
    expect(resolveEdgeSide(petNearItsLeftEdge, secondaryDisplay)).toBe('left')
    const petNearItsRightEdge = { x: 1920 + 1920 - 132, y: 100, width: 132, height: 132 }
    expect(resolveEdgeSide(petNearItsRightEdge, secondaryDisplay)).toBe('right')
  })
})

describe('resolveStableEdgeSide', () => {
  it('keeps the previous side when the episode is still active, ignoring the freshly computed one', () => {
    expect(resolveStableEdgeSide('left', 'right', true)).toBe('left')
  })

  it('adopts the freshly computed side when there is no previous side yet (first EDGE evaluate of a new episode)', () => {
    expect(resolveStableEdgeSide(null, 'right', true)).toBe('right')
  })

  it('adopts the freshly computed side when the episode is not active (a new episode, previous side is stale)', () => {
    expect(resolveStableEdgeSide('left', 'right', false)).toBe('right')
  })
})

describe('computeEdgeBounds', () => {
  const visibleSliverPx = 40

  it('positions the window mostly off the left edge, keeping Y/width/height, on a display at the origin', () => {
    const current = { x: 500, y: 300, width: 132, height: 132 }
    const display = { x: 0, y: 0, width: 1920, height: 1080 }
    expect(computeEdgeBounds(current, display, 'left', visibleSliverPx)).toEqual({
      x: 0 - (132 - visibleSliverPx),
      y: 300,
      width: 132,
      height: 132,
    })
  })

  it('positions the window mostly off the right edge, keeping Y/width/height, on a display at the origin', () => {
    const current = { x: 500, y: 300, width: 132, height: 132 }
    const display = { x: 0, y: 0, width: 1920, height: 1080 }
    expect(computeEdgeBounds(current, display, 'right', visibleSliverPx)).toEqual({
      x: 0 + 1920 - visibleSliverPx,
      y: 300,
      width: 132,
      height: 132,
    })
  })

  // Off-by-origin guard (the mandatory case a single-monitor dev box can't catch): a secondary
  // display's bounds.x is not 0. Both sides must be computed relative to that origin.
  it('accounts for a non-zero display origin on the left side', () => {
    const current = { x: 2200, y: 50, width: 132, height: 132 }
    const display = { x: 1920, y: 0, width: 1920, height: 1080 }
    expect(computeEdgeBounds(current, display, 'left', visibleSliverPx)).toEqual({
      x: 1920 - (132 - visibleSliverPx),
      y: 50,
      width: 132,
      height: 132,
    })
  })

  it('accounts for a non-zero display origin on the right side', () => {
    const current = { x: 2200, y: 50, width: 132, height: 132 }
    const display = { x: 1920, y: 0, width: 1920, height: 1080 }
    expect(computeEdgeBounds(current, display, 'right', visibleSliverPx)).toEqual({
      x: 1920 + 1920 - visibleSliverPx,
      y: 50,
      width: 132,
      height: 132,
    })
  })
})

describe('EDGE_VISIBLE_SLIVER_PX', () => {
  // Fix 7（second rework pass）：the previous assertion (`> 0 && < 132`) passes for almost any
  // value and pins nothing about the constant's actual intent — "exactly this many pixels stay
  // visible inside the display". Routed through computeEdgeBounds on both sides instead, so a
  // future change to the constant (or an accidental off-by-one in computeEdgeBounds itself) that
  // shrinks/grows the visible sliver would be caught here.
  it('leaves exactly this many pixels of the window inside the display, on both edges', () => {
    const display = { x: 0, y: 0, width: 1920, height: 1080 }
    const current = { x: 500, y: 300, width: 132, height: 132 }

    const leftBounds = computeEdgeBounds(current, display, 'left', EDGE_VISIBLE_SLIVER_PX)
    // Left placement: the window's right edge is what remains inside the display.
    expect(leftBounds.x + leftBounds.width - display.x).toBe(EDGE_VISIBLE_SLIVER_PX)

    const rightBounds = computeEdgeBounds(current, display, 'right', EDGE_VISIBLE_SLIVER_PX)
    // Right placement: the window's left edge is what remains inside the display.
    expect(display.x + display.width - rightBounds.x).toBe(EDGE_VISIBLE_SLIVER_PX)
  })
})

describe('diffChatState', () => {
  it('produces no side effects when the desired state is unchanged from applied', () => {
    const desired = { presence: 'SHOWN' as const, displayId: 1, alwaysOnTop: true }
    expect(diffChatState(desired, 1, true)).toEqual({ move: null, alwaysOnTop: true, visibility: null })
  })

  it('hides without moving when transitioning to SUPPRESSED while currently visible elsewhere', () => {
    const desired = { presence: 'SUPPRESSED' as const, displayId: 1, alwaysOnTop: false }
    expect(diffChatState(desired, 2, true)).toEqual({ move: null, alwaysOnTop: false, visibility: 'hide' })
  })

  it('shows (via showInactive, decided by the caller) when recovering from SUPPRESSED', () => {
    const desired = { presence: 'SHOWN' as const, displayId: 1, alwaysOnTop: true }
    expect(diffChatState(desired, 1, false)).toEqual({ move: null, alwaysOnTop: true, visibility: 'show' })
  })

  it('drops alwaysOnTop for NORMAL without touching visibility', () => {
    const desired = { presence: 'NORMAL' as const, displayId: 1, alwaysOnTop: false }
    expect(diffChatState(desired, 1, true)).toEqual({ move: null, alwaysOnTop: false, visibility: null })
  })
})

describe('canAcceptFullPlacement', () => {
  it('accepts a display with no blocker recorded', () => {
    expect(canAcceptFullPlacement(1, makeMap([]))).toBe(true)
  })

  it('refuses a display with a recorded blocker', () => {
    expect(canAcceptFullPlacement(1, makeMap([[1, {}]]))).toBe(false)
  })
})

describe('deriveDragContext (Fix 1 — one definition of home shared with the resolvers)', () => {
  it('treats "no applied displayId yet" (first-ever drag) as being at home', () => {
    expect(deriveDragContext(null, 5)).toEqual({
      currentDisplayId: 5,
      temporaryRelocation: false,
    })
  })

  it('is not a temporary relocation when the applied display matches the effective home', () => {
    expect(deriveDragContext(1, 1)).toEqual({
      currentDisplayId: 1,
      temporaryRelocation: false,
    })
  })

  it('detects a temporary relocation when the applied display differs from the effective home', () => {
    expect(deriveDragContext(2, 1)).toEqual({
      currentDisplayId: 2,
      temporaryRelocation: true,
    })
  })

  // The fresh-profile scenario Fix 1 closes: preferredDisplayId has never been committed, so
  // the effective home is whatever resolveStartupDisplay falls back to (here: display 1, the
  // fallback/largest display) — the caller is responsible for computing that fallback and
  // passing it in as effectiveHomeDisplayId, this function never sees the raw nullable
  // preferredDisplayId. Home got blocked, the resolver auto-relocated the window to display 2
  // (appliedDisplayId = 2). Dragging to a third display C (3) must be evaluated as a
  // relocation away from home 1, not as "at home" — otherwise persistBoundsNow would commit C
  // as the new home, which is exactly the bug this fix closes.
  it('fresh profile: auto-relocated away from the fallback home reads as a relocation, not "at home"', () => {
    const context = deriveDragContext(2, 1)
    expect(context).toEqual({
      currentDisplayId: 2,
      temporaryRelocation: true,
    })

    const outcome = resolveDragOutcome(
      context.temporaryRelocation,
      context.currentDisplayId,
      3,
      makeMap([])
    )
    expect(outcome).toEqual({ kind: 'accept', newPreferredDisplayId: null, boundsWriteDisplayId: 3 })
  })

  // Fix C（second rework pass）: appliedDisplayIdFor (windowBehavior.ts) returns null once the
  // display it recorded is no longer connected (e.g. the monitor holding the window was
  // unplugged) — deriveDragContext never sees the stale, disconnected id, it sees the same null
  // it would see on a fresh profile that has never applied anything. This is deliberately the
  // exact same case as the "no applied displayId yet" test above: an OS-forced 'moved' after an
  // unplug is indistinguishable at this layer from any other "no applied id" situation, and it
  // must fall back to reading as "at home" (an at-home placement) rather than being misread as a
  // cross-display drag that would commit a phantom new home.
  it('appliedDisplayId === null (post-unplug invalidation) reads as being at home, not as a cross-display drag', () => {
    expect(deriveDragContext(null, 7)).toEqual({
      currentDisplayId: 7,
      temporaryRelocation: false,
    })
  })
})

describe('extendQuietUntil (quiet windows extend, never shorten)', () => {
  it('extends when the new expiry is later', () => {
    expect(extendQuietUntil(1000, 900, 500)).toBe(1400)
  })

  it('keeps the existing expiry when the new one would be earlier', () => {
    // the real regression this guards: a 150ms animation tail landing inside a 1000ms topology
    // settle window must not truncate it back to 150ms, which would let the OS's own
    // post-unplug reposition 'moved' reach persistBoundsNow
    expect(extendQuietUntil(2000, 1000, 150)).toBe(2000)
  })

  it('treats an absent record (0) as immediately expired', () => {
    expect(extendQuietUntil(0, 5000, 1000)).toBe(6000)
  })
})

describe('isProgrammaticMoveEcho (Fix A — one classifier for both windowBehavior.ts call sites)', () => {
  it('is an echo while a programmatic move is in flight, regardless of the quiet window', () => {
    expect(isProgrammaticMoveEcho(true, 0, 1000)).toBe(true)
  })

  it('is an echo while now is before the quiet-until expiry, even when nothing is in flight', () => {
    expect(isProgrammaticMoveEcho(false, 1500, 1000)).toBe(true)
  })

  it('is not an echo once now has reached the quiet-until expiry and nothing is in flight', () => {
    expect(isProgrammaticMoveEcho(false, 1000, 1000)).toBe(false)
  })

  it('is not an echo well past the quiet-until expiry with nothing in flight', () => {
    expect(isProgrammaticMoveEcho(false, 500, 1000)).toBe(false)
  })

  it('in flight still counts as an echo even if the quiet window already expired', () => {
    expect(isProgrammaticMoveEcho(true, 500, 1000)).toBe(true)
  })
})

describe('isTemporaryPlacement (notePlacement store-vs-delete decision)', () => {
  it('is false (delete: no rollback record needed) when the placement is on the effective home display', () => {
    expect(isTemporaryPlacement(1, 1)).toBe(false)
  })

  it('is true (store: keep a rollback record) when the placement is on any other display', () => {
    expect(isTemporaryPlacement(2, 1)).toBe(true)
  })
})

describe('resolveDragOutcome (drag-end legality + placement rules)', () => {
  describe('at home (temporaryRelocation = false) — legality never applies', () => {
    it('drop in place — preference unchanged, that display’s bounds updated', () => {
      expect(resolveDragOutcome(false, 1, 1, makeMap([]))).toEqual({
        kind: 'accept',
        newPreferredDisplayId: null,
        boundsWriteDisplayId: 1,
      })
    })

    it('drop onto another (free) display D — home moves to D, D’s bounds updated', () => {
      expect(resolveDragOutcome(false, 1, 2, makeMap([]))).toEqual({
        kind: 'accept',
        newPreferredDisplayId: 2,
        boundsWriteDisplayId: 2,
      })
    })

    it('drop onto another display D that is currently BLOCKED — still accepted (a deliberate home move, resolver dodges it away later)', () => {
      const map = makeMap([[2, {}]])
      expect(resolveDragOutcome(false, 1, 2, map)).toEqual({
        kind: 'accept',
        newPreferredDisplayId: 2,
        boundsWriteDisplayId: 2,
      })
    })
  })

  // One rule covers every drop while temporarily relocated: read the latest DisplayStateMap,
  // reject if the drop display is still blocked, otherwise accept and write that display's
  // preferred position — never the home display id. Which display the relocation originally
  // fled from plays no part: it is not a permanent no-go zone, only the current blocker is.
  describe('temporarily relocated (temporaryRelocation = true)', () => {
    it('drop back on the original home A when A is free — accepted, A’s bounds written, home untouched', () => {
      const map = makeMap([]) // A (1) currently has no blocker
      expect(resolveDragOutcome(true, 2, 1, map)).toEqual({
        kind: 'accept',
        newPreferredDisplayId: null,
        boundsWriteDisplayId: 1,
      })
    })

    it('drop back on A when A still has a blocker — rejected', () => {
      const map = makeMap([[1, {}]]) // A (1) still blocked
      expect(resolveDragOutcome(true, 2, 1, map)).toEqual({ kind: 'reject' })
    })

    // Changed behaviour: an in-place nudge on the refuge display used to write nothing at all.
    // "If I'm going to sit on B for a while, I want it here" is still a user preference about B,
    // so B's preferred position is written — what must never move is the home display id.
    it('in-place nudge on the refuge display B — accepted, B’s bounds written, home untouched', () => {
      expect(resolveDragOutcome(true, 2, 2, makeMap([]))).toEqual({
        kind: 'accept',
        newPreferredDisplayId: null,
        boundsWriteDisplayId: 2,
      })
    })

    // Also changed: the refuge display is no longer exempt from the legality check. A blocker can
    // appear on B after the auto-relocation put the window there (a game launched on B mid-drag),
    // and a drop is only ever validated against the map as it reads right now.
    it('in-place nudge on the refuge display B when B has since become blocked — rejected', () => {
      expect(resolveDragOutcome(true, 2, 2, makeMap([[2, {}]]))).toEqual({ kind: 'reject' })
    })

    it('drop onto a free third display C — accepted, only C’s bounds written, home unchanged', () => {
      expect(resolveDragOutcome(true, 2, 3, makeMap([]))).toEqual({
        kind: 'accept',
        newPreferredDisplayId: null,
        boundsWriteDisplayId: 3,
      })
    })

    it('drop onto a blocked third display C — rejected', () => {
      const map = makeMap([[3, {}]])
      expect(resolveDragOutcome(true, 2, 3, map)).toEqual({ kind: 'reject' })
    })

    // The invariant that matters most here, asserted over the whole input space rather than
    // relied on case by case: nothing reachable while temporarily relocated may rewrite home.
    it('never returns a newPreferredDisplayId, for any drop display and any blocker layout', () => {
      for (const dropDisplayId of [1, 2, 3]) {
        for (const blocked of [[], [[1, {}]], [[2, {}]], [[3, {}]], [[1, {}], [2, {}], [3, {}]]] as const) {
          const outcome = resolveDragOutcome(true, 2, dropDisplayId, makeMap(blocked as never))
          if (outcome.kind === 'accept') expect(outcome.newPreferredDisplayId).toBeNull()
        }
      }
    })
  })
})

describe('resolveEdgeHoverBounds (Stage 3 part 2, Task 2)', () => {
  const edgeBounds = { x: -92, y: 50, width: 132, height: 132 }
  const fullBounds = { x: 0, y: 50, width: 132, height: 132 }

  // Mandatory sanity check (ii): if this function is changed to always return fullBounds
  // regardless of `hovered`, this assertion must go RED.
  it('returns edgeBounds (collapsed) when not hovered', () => {
    expect(resolveEdgeHoverBounds(edgeBounds, fullBounds, false)).toBe(edgeBounds)
  })

  it('returns fullBounds (expanded) when hovered', () => {
    expect(resolveEdgeHoverBounds(edgeBounds, fullBounds, true)).toBe(fullBounds)
  })
})

describe('computeHandleSuppressed (Resolver/Controller 边界修正 — safety gate reads intent ∪ fact)', () => {
  // Mandatory sanity check (ii): if this is ever changed to read only `applied` (dropping the
  // latestDesired half), this assertion must go RED — front edge must suppress the instant
  // desired becomes EDGE, even while applied has not caught up yet (fail-closed).
  it('suppresses the instant desired becomes EDGE, even while applied has not caught up (front edge, fail-closed)', () => {
    expect(computeHandleSuppressed('EDGE', 'AMBIENT')).toBe(true)
  })

  it('keeps suppressing while desired has already left EDGE but applied has not settled yet (trailing edge)', () => {
    expect(computeHandleSuppressed('AMBIENT', 'EDGE')).toBe(true)
  })

  it('releases only once neither desired nor applied is EDGE', () => {
    expect(computeHandleSuppressed('AMBIENT', 'AMBIENT')).toBe(false)
  })

  it('stays suppressed in the steady state where both are EDGE', () => {
    expect(computeHandleSuppressed('EDGE', 'EDGE')).toBe(true)
  })
})

describe('presencePayloadChanged (Stage 3 part 2, Task 1 — broadcast only on change)', () => {
  it('is unconditionally true when there has never been a previous broadcast (previous = null)', () => {
    expect(presencePayloadChanged(null, { presence: 'AMBIENT', edgeSide: null, handleSuppressed: false })).toBe(true)
  })

  it('is false when presence, edgeSide, and handleSuppressed are all unchanged', () => {
    const payload = { presence: 'EDGE' as const, edgeSide: 'left' as const, handleSuppressed: true }
    expect(presencePayloadChanged(payload, { ...payload })).toBe(false)
  })

  it('is true when presence changed', () => {
    expect(
      presencePayloadChanged(
        { presence: 'AMBIENT', edgeSide: null, handleSuppressed: false },
        { presence: 'EDGE', edgeSide: 'left', handleSuppressed: true }
      )
    ).toBe(true)
  })

  it('is true when only edgeSide changed (presence still EDGE)', () => {
    expect(
      presencePayloadChanged(
        { presence: 'EDGE', edgeSide: 'left', handleSuppressed: true },
        { presence: 'EDGE', edgeSide: 'right', handleSuppressed: true }
      )
    ).toBe(true)
  })

  // This is the case that would be invisible if handleSuppressed were not compared: desired just
  // became EDGE (front edge, fail-closed) while applied has not caught up — presence/edgeSide are
  // unchanged, only handleSuppressed flips.
  it('is true when only handleSuppressed changed (presence/edgeSide unchanged — the fail-closed front-edge case)', () => {
    expect(
      presencePayloadChanged(
        { presence: 'AMBIENT', edgeSide: null, handleSuppressed: false },
        { presence: 'AMBIENT', edgeSide: null, handleSuppressed: true }
      )
    ).toBe(true)
  })
})
