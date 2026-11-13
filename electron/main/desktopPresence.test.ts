import { describe, it, expect } from 'vitest'
import {
  resolvePetDesiredState,
  resolveChatDesiredState,
  diffPetState,
  diffChatState,
  resolveDragOutcome,
  canAcceptFullPlacement,
  deriveDragContext,
  resolveNextDisplayTarget,
  isTemporaryPlacement,
  isProgrammaticMoveEcho,
  extendQuietUntil,
  resolveEdgeSide,
  resolveStableEdgeSide,
  computeEdgeBounds,
  resolveEdgeHoverBounds,
  presencePayloadChanged,
  computeHandleSuppressed,
  petMode,
  petModeIgnoresMouse,
  petModeTargetOpacity,
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

  it('picks the lowest-id free display deterministically when several are free', () => {
    const map = makeMap([[1, {}]])
    expect(resolvePetDesiredState(NOT_INTERACTING, UNUSED_CURRENT_DISPLAY_ID, 1, map, [1, 3, 2])).toEqual({ presence: 'AMBIENT', displayId: 2, alwaysOnTop: true })
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

  it('relocates away from a display that becomes blocked mid-relocation, independent of which other display was previously free', () => {
    // 多屏同时各自独立 blocked 的场景：home(1) 与曾经的避难屏(2) 现在都被挡住，3 空闲
    const map = makeMap([
      [1, {}],
      [2, {}],
    ])
    expect(resolvePetDesiredState(NOT_INTERACTING, UNUSED_CURRENT_DISPLAY_ID, 1, map, [1, 2, 3])).toEqual({ presence: 'AMBIENT', displayId: 3, alwaysOnTop: true })
  })

  it('stays on the current free non-home display when a lower-id free display exists', () => {
    const map = makeMap([[1, {}]])
    expect(resolvePetDesiredState(NOT_INTERACTING, 3, 1, map, [1, 2, 3])).toEqual({ presence: 'AMBIENT', displayId: 3, alwaysOnTop: true })
  })

  it('relocates to the lowest-id free display when the current display becomes blocked', () => {
    const map = makeMap([[1, {}], [3, {}]])
    expect(resolvePetDesiredState(NOT_INTERACTING, 3, 1, map, [1, 2, 3, 4])).toEqual({ presence: 'AMBIENT', displayId: 2, alwaysOnTop: true })
  })

  it('returns home when home is free, even if the current display is another free one', () => {
    expect(resolvePetDesiredState(NOT_INTERACTING, 3, 1, makeMap([]), [1, 2, 3])).toEqual({ presence: 'AMBIENT', displayId: 1, alwaysOnTop: true })
  })

  it('relocates to the lowest-id free display when the current display equals home and home is blocked', () => {
    expect(resolvePetDesiredState(NOT_INTERACTING, 1, 1, makeMap([[1, {}]]), [1, 2, 3])).toEqual({ presence: 'AMBIENT', displayId: 2, alwaysOnTop: true })
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
    expect(diffPetState(desired, 2, true).move).toBeNull()
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

  it('interacting still pre-empts avoidance being disabled — dragging is orthogonal to avoidance', () => {
    const map = makeMap([[1, {}]])
    expect(resolvePetDesiredState(true, 1, 1, map, [1], false)).toEqual({ presence: 'ACTIVE', displayId: 1, alwaysOnTop: true })
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

  it('stays on the current free non-home display when a lower-id free display exists', () => {
    const map = makeMap([[1, {}]])
    expect(resolveChatDesiredState(1, map, [1, 2, 3], 3)).toEqual({ presence: 'SHOWN', displayId: 3, alwaysOnTop: true })
  })

  it('relocates to the lowest-id free display when the current display becomes blocked', () => {
    const map = makeMap([[1, {}], [3, {}]])
    expect(resolveChatDesiredState(1, map, [1, 2, 3, 4], 3)).toEqual({ presence: 'SHOWN', displayId: 2, alwaysOnTop: true })
  })

  it('returns home when home is free, even if the current display is another free one', () => {
    expect(resolveChatDesiredState(1, makeMap([]), [1, 2, 3], 3)).toEqual({ presence: 'SHOWN', displayId: 1, alwaysOnTop: true })
  })

  it('relocates to the lowest-id free display when the current display equals home and home is blocked', () => {
    const map = makeMap([[1, {}]])
    expect(resolveChatDesiredState(1, map, [1, 2, 3], 1)).toEqual({ presence: 'SHOWN', displayId: 2, alwaysOnTop: true })
  })

  it('relocates to the lowest-id free display when the current display id is not in the display list', () => {
    const map = makeMap([[1, {}]])
    expect(resolveChatDesiredState(1, map, [1, 2, 3], 99)).toEqual({ presence: 'SHOWN', displayId: 2, alwaysOnTop: true })
  })

  it('relocates to the lowest-id free display when the current display is null and home is blocked', () => {
    const map = makeMap([[1, {}]])
    expect(resolveChatDesiredState(1, map, [1, 2, 3], null)).toEqual({ presence: 'SHOWN', displayId: 2, alwaysOnTop: true })
  })
})

describe('diffPetState', () => {
  it('produces no side effects when the desired state is unchanged from applied (idempotency requirement)', () => {
    const desired = { presence: 'AMBIENT' as const, displayId: 1, alwaysOnTop: true }
    expect(diffPetState(desired, 1, true)).toEqual({ move: null, visibility: null })
  })

  it('moves and shows on first-ever resolve (appliedDisplayId null, currently hidden)', () => {
    const desired = { presence: 'AMBIENT' as const, displayId: 1, alwaysOnTop: true }
    expect(diffPetState(desired, null, false)).toEqual({ move: 1, visibility: 'show' })
  })

  it('hides without moving when transitioning to HIDDEN while currently visible on a different display', () => {
    const desired = { presence: 'HIDDEN' as const, displayId: 1, alwaysOnTop: false }
    expect(diffPetState(desired, 2, true)).toEqual({ move: null, visibility: 'hide' })
  })

  it('still moves while already hidden (pre-positions it for the next reveal)', () => {
    const desired = { presence: 'HIDDEN' as const, displayId: 1, alwaysOnTop: false }
    expect(diffPetState(desired, 2, false)).toEqual({ move: 1, visibility: null })
  })

  // Stage 3: ACTIVE and EDGE are both visible, exactly like AMBIENT (see diffPetState's
  // HIDDEN_PET_PRESENCES comment — visibility is "everything except HIDDEN", not
  // `=== 'AMBIENT'`). These two guard against silently regressing back to the old hardcoded
  // comparison, which would have judged both of these as invisible.
  it('shows on first reveal when desired is ACTIVE (not just AMBIENT)', () => {
    const desired = { presence: 'ACTIVE' as const, displayId: 1, alwaysOnTop: true }
    expect(diffPetState(desired, null, false)).toEqual({ move: 1, visibility: 'show' })
  })

  it('shows on first reveal when desired is EDGE (not just AMBIENT)', () => {
    const desired = { presence: 'EDGE' as const, displayId: 1, alwaysOnTop: true }
    expect(diffPetState(desired, null, false)).toEqual({ move: 1, visibility: 'show' })
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
              const transition = diffPetState({ presence, displayId, alwaysOnTop: presence !== 'HIDDEN' }, appliedDisplayId, isCurrentlyVisible)
              if (transition.visibility === 'hide') {
                expect(transition.move).toBeNull()
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

describe('resolveNextDisplayTarget', () => {
  const row = [
    { id: 1, bounds: { x: 0, y: 0 } },
    { id: 2, bounds: { x: 1920, y: 0 } },
    { id: 3, bounds: { x: 3840, y: 0 } },
  ]
  const unordered = [row[2], row[0], row[1]]
  const stacked = [
    { id: 7, bounds: { x: 0, y: 1080 } },
    { id: 8, bounds: { x: 0, y: 0 } },
    { id: 9, bounds: { x: 1920, y: 0 } },
  ]
  const cases: Array<[string, typeof row, number, number, Array<[number, Partial<DisplayBlocker>]>, boolean, number | null]> = [
    ['moves to the display on the right', unordered, 1, 1, [], true, 2],
    ['wraps from the rightmost display to the leftmost', row, 3, 3, [], true, 1],
    ['skips a display that needs avoidance', row, 1, 1, [[2, {}]], true, 3],
    ['does not skip it with avoidance off', row, 1, 1, [[2, {}]], false, 2],
    ['has no target when every other display needs avoidance', row, 1, 1, [[2, {}], [3, { severity: 'soft' }]], true, null],
    ['temporary relocation, two displays, home needs avoidance: stays on the current display', row.slice(0, 2), 2, 1, [[1, {}]], true, 2],
    ['has no target with a single display', row.slice(0, 1), 1, 1, [], true, null],
    ['orders displays with the same x by y', stacked, 8, 8, [], true, 7],
  ]
  it.each(cases)('%s', (_name, displays, current, home, blockers, avoidanceEnabled, expected) => {
    expect(resolveNextDisplayTarget(displays, current, home, makeMap(blockers), avoidanceEnabled)).toBe(expected)
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
})

describe('presencePayloadChanged (Stage 3 part 2, Task 1 — broadcast only on change)', () => {
  const AMBIENT = { presence: 'AMBIENT' as const, edgeSide: null, handleSuppressed: false, collapsed: false, clickThrough: false }

  it('is unconditionally true when there has never been a previous broadcast (previous = null)', () => {
    expect(presencePayloadChanged(null, AMBIENT)).toBe(true)
  })

  it('is false when every field is unchanged', () => {
    const payload = { presence: 'EDGE' as const, edgeSide: 'left' as const, handleSuppressed: true, collapsed: false, clickThrough: true }
    expect(presencePayloadChanged(payload, { ...payload })).toBe(false)
  })

  it('is true when only edgeSide changed (presence still EDGE)', () => {
    const left = { ...AMBIENT, presence: 'EDGE' as const, edgeSide: 'left' as const, handleSuppressed: true }
    expect(presencePayloadChanged(left, { ...left, edgeSide: 'right' })).toBe(true)
  })

  // This is the case that would be invisible if handleSuppressed were not compared: desired just
  // became EDGE (front edge, fail-closed) while applied has not caught up — presence/edgeSide are
  // unchanged, only handleSuppressed flips.
  it('is true when only handleSuppressed changed (presence/edgeSide unchanged — the fail-closed front-edge case)', () => {
    expect(presencePayloadChanged(AMBIENT, { ...AMBIENT, handleSuppressed: true })).toBe(true)
  })

  it('is true when only collapsed changed', () => {
    expect(presencePayloadChanged(AMBIENT, { ...AMBIENT, collapsed: true })).toBe(true)
  })

  it('is true when only clickThrough changed', () => {
    expect(presencePayloadChanged(AMBIENT, { ...AMBIENT, clickThrough: true })).toBe(true)
  })
})

describe('computeHandleSuppressed while collapsed (the handle is the whole window)', () => {
  it('is never suppressed, even with EDGE desired or applied', () => {
    expect(computeHandleSuppressed('EDGE', 'EDGE', true)).toBe(false)
    expect(computeHandleSuppressed('EDGE', 'AMBIENT', true)).toBe(false)
    expect(computeHandleSuppressed('AMBIENT', 'EDGE', true)).toBe(false)
  })
})

describe('petMode', () => {
  it('is normal with neither flag', () => {
    expect(petMode(false, false)).toBe('normal')
  })

  it('is clickThrough when only click-through is set', () => {
    expect(petMode(false, true)).toBe('clickThrough')
  })

  it('is collapsed when only collapsed is set', () => {
    expect(petMode(true, false)).toBe('collapsed')
  })

  it('lets collapsed win over click-through', () => {
    expect(petMode(true, true)).toBe('collapsed')
  })
})

describe('petModeIgnoresMouse / petModeTargetOpacity', () => {
  it('maps each mode to its mouse handling and opacity', () => {
    expect(petModeIgnoresMouse('normal')).toBe(false)
    expect(petModeIgnoresMouse('clickThrough')).toBe(true)
    expect(petModeIgnoresMouse('collapsed')).toBe(false)
    expect(petModeTargetOpacity('normal')).toBe(1)
    expect(petModeTargetOpacity('clickThrough')).toBe(0.6)
    expect(petModeTargetOpacity('collapsed')).toBe(1)
  })
})
