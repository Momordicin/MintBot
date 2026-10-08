import { describe, it, expect } from 'vitest'
import {
  classifyBlockingReasons,
  applyExternalObservation,
  decideBlockerAfterValidation,
  validateBlockers,
  pickPrecedentBlocker,
} from './displayStateMap'
import type { BlockerProbe, BlockingRules, DisplayBlocker, DisplayStateMap, AppRule } from './displayStateMap'
import type { ExternalWindowInfo } from './activeWindowMonitor'

const NO_RULES: BlockingRules = { appRules: [] }

function rules(...appRules: AppRule[]): BlockingRules {
  return { appRules }
}

function makeInfo(overrides: Partial<ExternalWindowInfo> = {}): ExternalWindowInfo {
  return {
    hwnd: 1000n,
    pid: 111,
    title: 'Window',
    isFullscreen: false,
    exeName: 'app.exe',
    displayId: 1,
    ...overrides,
  }
}

function makeBlocker(overrides: Partial<DisplayBlocker> = {}): DisplayBlocker {
  return {
    hwnd: 1000n,
    pid: 111,
    exeName: 'game.exe',
    displayId: 1,
    reasons: new Set(['fullscreen']),
    severity: 'hard',
    ...overrides,
  }
}

describe('classifyBlockingReasons', () => {
  it('fullscreen observation establishes the fullscreen reason', () => {
    const reasons = classifyBlockingReasons(makeInfo({ isFullscreen: true }), NO_RULES)
    expect(reasons).toEqual(new Set(['fullscreen']))
  })

  it('a foreground exe matching a hard rule establishes the user-rule reason', () => {
    const reasons = classifyBlockingReasons(
      makeInfo({ exeName: 'bad.exe', isFullscreen: false }),
      rules({ exeName: 'bad.exe', effect: 'hard' })
    )
    expect(reasons).toEqual(new Set(['user-rule']))
  })

  it('a foreground exe matching a soft rule establishes the user-rule reason', () => {
    const reasons = classifyBlockingReasons(
      makeInfo({ exeName: 'ide.exe', isFullscreen: false }),
      rules({ exeName: 'ide.exe', effect: 'soft' })
    )
    expect(reasons).toEqual(new Set(['user-rule']))
  })

  it('an exe matching an allow rule suppresses any blocker, even while fullscreen', () => {
    const reasons = classifyBlockingReasons(
      makeInfo({ exeName: 'game.exe', isFullscreen: true }),
      rules({ exeName: 'game.exe', effect: 'allow' })
    )
    expect(reasons.size).toBe(0)
  })

  it('neither fullscreen nor rule-matched produces no reasons', () => {
    const reasons = classifyBlockingReasons(makeInfo({ isFullscreen: false, exeName: 'notepad.exe' }), NO_RULES)
    expect(reasons.size).toBe(0)
  })
})

describe('severity composition (max severity wins, rule-derived — Stage 4)', () => {
  it('a hard rule alone produces hard severity', () => {
    const map = applyExternalObservation(
      new Map(),
      makeInfo({ exeName: 'game.exe', isFullscreen: false, displayId: 1 }),
      rules({ exeName: 'game.exe', effect: 'hard' })
    )
    expect(map.get(1)).toMatchObject({ severity: 'hard', reasons: new Set(['user-rule']) })
  })

  it('a soft rule alone (not fullscreen) produces soft severity — this is what makes EDGE reachable', () => {
    const map = applyExternalObservation(
      new Map(),
      makeInfo({ exeName: 'ide.exe', isFullscreen: false, displayId: 1 }),
      rules({ exeName: 'ide.exe', effect: 'soft' })
    )
    expect(map.get(1)).toMatchObject({ severity: 'soft', reasons: new Set(['user-rule']) })
  })

  it('fullscreen always contributes hard, regardless of the rule matched', () => {
    expect(classifyBlockingReasonsSeverity(NO_RULES)).toBe('hard')

    function classifyBlockingReasonsSeverity(r: BlockingRules) {
      const map = applyExternalObservation(new Map(), makeInfo({ isFullscreen: true, displayId: 1 }), r)
      return map.get(1)?.severity
    }
  })

  // The consequence the task spec explicitly calls out: an app marked 'soft' that goes genuinely
  // fullscreen still resolves to 'hard' — the fullscreen detector's own hard contribution is not
  // suppressed by a soft app rule. "This app should only ever get soft treatment, even while
  // fullscreen" is not expressible in v1.
  it('a soft-rule app that is ALSO genuinely fullscreen resolves to hard, not soft (documented v1 limitation)', () => {
    const map = applyExternalObservation(
      new Map(),
      makeInfo({ exeName: 'ide.exe', isFullscreen: true, displayId: 1 }),
      rules({ exeName: 'ide.exe', effect: 'soft' })
    )
    expect(map.get(1)).toMatchObject({ severity: 'hard', reasons: new Set(['fullscreen', 'user-rule']) })
  })

  it('allow suppresses the user-rule reason but not a mismatched OTHER blocker on a different display', () => {
    const withAllow = applyExternalObservation(
      new Map(),
      makeInfo({ exeName: 'game.exe', isFullscreen: true, displayId: 1 }),
      rules({ exeName: 'game.exe', effect: 'allow' })
    )
    expect(withAllow.has(1)).toBe(false)
  })
})

describe('applyExternalObservation — establishment', () => {
  it('establishes a blocker for a fullscreen observation on its own display', () => {
    const map: DisplayStateMap = new Map()
    const next = applyExternalObservation(map, makeInfo({ isFullscreen: true, displayId: 1 }), NO_RULES)
    expect(next.get(1)).toMatchObject({ displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' })
  })

  it('establishes a blocker for a hard-rule exe', () => {
    const map: DisplayStateMap = new Map()
    const next = applyExternalObservation(map, makeInfo({ exeName: 'bad.exe', displayId: 2 }), rules({ exeName: 'bad.exe', effect: 'hard' }))
    expect(next.get(2)).toMatchObject({ displayId: 2, reasons: new Set(['user-rule']), severity: 'hard' })
  })

  it('an allow-rule exe never establishes a blocker even while fullscreen', () => {
    const map: DisplayStateMap = new Map()
    const next = applyExternalObservation(
      map,
      makeInfo({ exeName: 'game.exe', isFullscreen: true, displayId: 1 }),
      rules({ exeName: 'game.exe', effect: 'allow' })
    )
    expect(next.has(1)).toBe(false)
    expect(next).toBe(map) // no-op: same reference, nothing was touched
  })

  // Finding B（Stage 1 review）: a pid-less observation (transient GetWindowThreadProcessId
  // failure) must never establish a blocker — DisplayBlocker.pid exists to support the HWND
  // recycling cross-check in probeBlockerWindow, so a record without a verifiable pid would be
  // dishonest about what it can support
  it('never establishes a blocker when pid is unknown, even while fullscreen', () => {
    const map: DisplayStateMap = new Map()
    const next = applyExternalObservation(map, makeInfo({ pid: null, isFullscreen: true, displayId: 1 }), NO_RULES)
    expect(next.has(1)).toBe(false)
    expect(next).toBe(map)
  })

  // headline bug this stage fixes: a non-blocking observation on one display must not clear
  // an established blocker on a different display — the old design conflated "no information
  // about display B" with "display A's blocker is stale"
  it('a non-blocking observation on display B does not clear an established blocker on display A', () => {
    const withBlockerOnA = applyExternalObservation(new Map(), makeInfo({ isFullscreen: true, displayId: 1 }), NO_RULES)
    expect(withBlockerOnA.has(1)).toBe(true)

    const afterCleanObservationOnB = applyExternalObservation(
      withBlockerOnA,
      makeInfo({ isFullscreen: false, exeName: 'notepad.exe', displayId: 2 }),
      NO_RULES
    )

    expect(afterCleanObservationOnB.get(1)).toEqual(withBlockerOnA.get(1))
    expect(afterCleanObservationOnB.has(2)).toBe(false)
  })
})

describe('decideBlockerAfterValidation', () => {
  it('clears when the window no longer exists', () => {
    expect(decideBlockerAfterValidation(makeBlocker(), { status: 'gone' }, NO_RULES)).toBeNull()
  })

  it('clears when the pid no longer matches (HWND recycled to an unrelated process)', () => {
    expect(decideBlockerAfterValidation(makeBlocker(), { status: 'pid-mismatch' }, NO_RULES)).toBeNull()
  })

  it('re-attributes to the display the window has moved to, while still blocking', () => {
    const blocker = makeBlocker({ displayId: 1 })
    const decided = decideBlockerAfterValidation(blocker, { status: 'ok', displayId: 2, isFullscreen: true }, NO_RULES)
    expect(decided).toMatchObject({ displayId: 2, reasons: new Set(['fullscreen']), severity: 'hard' })
  })

  it('keeps the blocker when it still satisfies its blocking condition on the same display', () => {
    const blocker = makeBlocker({ displayId: 1 })
    const decided = decideBlockerAfterValidation(blocker, { status: 'ok', displayId: 1, isFullscreen: true }, NO_RULES)
    expect(decided).toMatchObject({ displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' })
  })

  it('clears when it no longer satisfies any blocking condition (e.g. left fullscreen, no rule matched)', () => {
    const blocker = makeBlocker({ displayId: 1, exeName: 'game.exe' })
    const decided = decideBlockerAfterValidation(blocker, { status: 'ok', displayId: 1, isFullscreen: false }, NO_RULES)
    expect(decided).toBeNull()
  })

  it('clears when the rules changed and the exe is now allowed', () => {
    const blocker = makeBlocker({ displayId: 1, exeName: 'game.exe' })
    const decided = decideBlockerAfterValidation(
      blocker,
      { status: 'ok', displayId: 1, isFullscreen: true },
      rules({ exeName: 'game.exe', effect: 'allow' })
    )
    expect(decided).toBeNull()
  })

  it('downgrades to soft when the rules changed the matched app rule from hard to soft and it is not fullscreen', () => {
    const blocker = makeBlocker({ displayId: 1, exeName: 'ide.exe', reasons: new Set(['user-rule']), severity: 'hard' })
    const decided = decideBlockerAfterValidation(
      blocker,
      { status: 'ok', displayId: 1, isFullscreen: false },
      rules({ exeName: 'ide.exe', effect: 'soft' })
    )
    expect(decided).toMatchObject({ severity: 'soft', reasons: new Set(['user-rule']) })
  })

  // Finding A（Stage 1 review）: a probe failure (exception, or resolvePid returning null) is not
  // evidence the window is gone — it must keep the blocker unchanged, unlike 'gone'/'pid-mismatch'
  it('keeps the blocker unchanged on a probe-error, unlike gone/pid-mismatch', () => {
    const blocker = makeBlocker({ displayId: 1, exeName: 'game.exe' })
    const decided = decideBlockerAfterValidation(blocker, { status: 'probe-error' }, NO_RULES)
    expect(decided).toEqual(blocker)
  })

  // conservative mode (new): used only during the small window a user drag is in progress
  // (electron/main/dragActivity.ts), because the drag itself can steal focus from the
  // fullscreen app on the source display and make isFullscreen momentarily false — a soft
  // signal that must not clear a blocker mid-drag.
  describe('conservative mode', () => {
    it('still clears on "gone", same as standard mode', () => {
      expect(decideBlockerAfterValidation(makeBlocker(), { status: 'gone' }, NO_RULES, 'conservative')).toBeNull()
    })

    it('still clears on "pid-mismatch", same as standard mode', () => {
      expect(
        decideBlockerAfterValidation(makeBlocker(), { status: 'pid-mismatch' }, NO_RULES, 'conservative')
      ).toBeNull()
    })

    it('still keeps the blocker unchanged (aside from displayId) on "probe-error", same as standard mode', () => {
      const blocker = makeBlocker({ displayId: 1, exeName: 'game.exe' })
      const decided = decideBlockerAfterValidation(blocker, { status: 'probe-error' }, NO_RULES, 'conservative')
      expect(decided).toEqual(blocker)
    })

    // The contrast that matters: standard mode treats isFullscreen=false as real evidence and
    // clears IMMEDIATELY. Conservative mode never clears on it — not "after N confirmations",
    // never. See decideBlockerAfterValidation's header comment for why a confirmation counter is
    // unsound here: N consecutive passes can just as easily mean "the user has been dragging the
    // pet for N*1500ms while the blocked game sat unfocused the whole time".
    it('"ok" with isFullscreen false: standard mode clears immediately, conservative mode never clears', () => {
      const blocker = makeBlocker({ displayId: 1, exeName: 'game.exe' })
      const probe: BlockerProbe = { status: 'ok', displayId: 1, isFullscreen: false }

      expect(decideBlockerAfterValidation(blocker, probe, NO_RULES, 'standard')).toBeNull()

      const conservative = decideBlockerAfterValidation(blocker, probe, NO_RULES, 'conservative')
      expect(conservative).not.toBeNull()
      expect(conservative).toMatchObject({ reasons: blocker.reasons, severity: blocker.severity })
    })

    it('conservative mode does not clear no matter how many consecutive soft-clear passes it sees', () => {
      // The regression this pins: any reintroduction of a confirmation counter (however large the
      // threshold) makes this loop eventually return null. The user's scenario is exactly this —
      // dragging the pet for several seconds keeps the blocked game unfocused for every pass.
      let blocker = makeBlocker({ displayId: 1, exeName: 'game.exe' })
      const softClearProbe: BlockerProbe = { status: 'ok', displayId: 1, isFullscreen: false }
      for (let i = 0; i < 50; i++) {
        const decided = decideBlockerAfterValidation(blocker, softClearProbe, NO_RULES, 'conservative')
        expect(decided).not.toBeNull()
        blocker = decided as DisplayBlocker
      }
      expect(blocker).toMatchObject({ reasons: new Set(['fullscreen']), severity: 'hard' })
    })

    it('"ok" in conservative mode still refreshes displayId (directly observed geometry, unaffected by focus)', () => {
      const blocker = makeBlocker({ displayId: 1, exeName: 'game.exe' })
      const decided = decideBlockerAfterValidation(
        blocker,
        { status: 'ok', displayId: 5, isFullscreen: false },
        NO_RULES,
        'conservative'
      )
      expect(decided).toMatchObject({ displayId: 5 })
    })

    it('hard evidence (gone) clears immediately in conservative mode', () => {
      const blocker = makeBlocker({ displayId: 1, exeName: 'game.exe' })
      expect(decideBlockerAfterValidation(blocker, { status: 'gone' }, NO_RULES, 'conservative')).toBeNull()
    })

    it('hard evidence (pid-mismatch) clears immediately in conservative mode', () => {
      const blocker = makeBlocker({ displayId: 1, exeName: 'game.exe' })
      expect(decideBlockerAfterValidation(blocker, { status: 'pid-mismatch' }, NO_RULES, 'conservative')).toBeNull()
    })
  })
})

describe('validateBlockers', () => {
  it('only probes the already-known blocker hwnds, not an arbitrary enumeration', () => {
    const map: DisplayStateMap = new Map([
      [1, makeBlocker({ displayId: 1, hwnd: 1000n, pid: 111 })],
      [2, makeBlocker({ displayId: 2, hwnd: 2000n, pid: 222 })],
    ])
    const probed: Array<[bigint, number]> = []
    const next = validateBlockers(map, NO_RULES, (hwnd, pid) => {
      probed.push([hwnd, pid])
      return { status: 'ok', displayId: hwnd === 1000n ? 1 : 2, isFullscreen: true }
    })
    expect(probed).toEqual([
      [1000n, 111],
      [2000n, 222],
    ])
    expect(next.size).toBe(2)
  })

  it('clears gone/pid-mismatched blockers while keeping and re-attributing the rest', () => {
    const map: DisplayStateMap = new Map([
      [1, makeBlocker({ displayId: 1, hwnd: 1000n, pid: 111 })], // will be reported gone
      [2, makeBlocker({ displayId: 2, hwnd: 2000n, pid: 222 })], // recycled HWND, pid mismatch
      [3, makeBlocker({ displayId: 3, hwnd: 3000n, pid: 333 })], // moved to display 4, still fullscreen
    ])
    const next = validateBlockers(map, NO_RULES, hwnd => {
      if (hwnd === 1000n) return { status: 'gone' }
      if (hwnd === 2000n) return { status: 'pid-mismatch' }
      return { status: 'ok', displayId: 4, isFullscreen: true }
    })
    expect(next.has(1)).toBe(false)
    expect(next.has(2)).toBe(false)
    expect(next.has(3)).toBe(false)
    expect(next.get(4)).toMatchObject({ displayId: 4, hwnd: 3000n })
  })

  // Finding A（Stage 1 review） sanity check: a probe-error must NOT behave like the old
  // "any failure clears the blocker" bug. If decideBlockerAfterValidation regressed to treating
  // 'probe-error' like 'gone', this would fail (the blocker on display 1 would disappear).
  it('a probe-error keeps a blocker through a validation pass, not just in isolation', () => {
    const map: DisplayStateMap = new Map([[1, makeBlocker({ displayId: 1, hwnd: 1000n, pid: 111 })]])
    const next = validateBlockers(map, NO_RULES, () => ({ status: 'probe-error' }))
    expect(next.get(1)).toEqual(map.get(1))
  })

  it('threads the mode through to decideBlockerAfterValidation: conservative mode keeps an "ok, isFullscreen: false" blocker that standard mode would clear', () => {
    const map: DisplayStateMap = new Map([[1, makeBlocker({ displayId: 1, hwnd: 1000n, pid: 111 })]])
    const probe = (): BlockerProbe => ({ status: 'ok', displayId: 1, isFullscreen: false })

    const standardResult = validateBlockers(map, NO_RULES, probe, 'standard')
    expect(standardResult.has(1)).toBe(false)

    const conservativeResult = validateBlockers(map, NO_RULES, probe, 'conservative')
    expect(conservativeResult.has(1)).toBe(true)
  })

  // Finding C（Stage 1 review）: two known blockers can both re-attribute to the same displayId
  // within one pass (e.g. two monitored windows both got dragged onto the same screen). The
  // outcome must be a deliberate rule, not whichever the Map happened to visit last.
  describe('collision precedence (two blockers re-attribute to the same display in one pass)', () => {
    // Stage 4: soft severity is now reachable end-to-end (a genuine soft AppRule, not just a
    // direct unit test of pickPrecedentBlocker) — this tier used to be unreachable before Stage 4
    // introduced a real soft rule effect (every reason used to map to 'hard').
    it('higher severity wins, reachable end to end through validateBlockers with a real soft rule', () => {
      const softBlocker = makeBlocker({ displayId: 1, hwnd: 1000n, pid: 111, exeName: 'ide.exe', reasons: new Set(['user-rule']), severity: 'soft' })
      const hardBlocker = makeBlocker({ displayId: 2, hwnd: 2000n, pid: 222, exeName: 'game.exe', reasons: new Set(['fullscreen']), severity: 'hard' })
      const map: DisplayStateMap = new Map([
        [1, softBlocker],
        [2, hardBlocker],
      ])
      // Deliberately NOT fullscreen for ide.exe (hwnd 1000n) — otherwise the fullscreen detector's
      // own hard contribution would swamp the soft rule and this stops being a genuine
      // soft-vs-hard collision (see the class-level comment on this describe block).
      const next = validateBlockers(map, rules({ exeName: 'ide.exe', effect: 'soft' }), hwnd => ({
        status: 'ok',
        displayId: 9,
        isFullscreen: hwnd === 2000n,
      }))
      expect(next.size).toBe(1)
      expect(next.get(9)).toMatchObject({ hwnd: 2000n, severity: 'hard' })
    })

    it('higher severity wins, checked directly against pickPrecedentBlocker (soft vs hard, order-independent)', () => {
      const soft = makeBlocker({ displayId: 1, hwnd: 1000n, pid: 111, reasons: new Set(['user-rule']), severity: 'soft' })
      const hard = makeBlocker({ displayId: 2, hwnd: 2000n, pid: 222, reasons: new Set(['fullscreen']), severity: 'hard' })
      expect(pickPrecedentBlocker(soft, hard)).toBe(hard)
      expect(pickPrecedentBlocker(hard, soft)).toBe(hard) // order-independent
    })

    it('same severity: more reasons wins', () => {
      const fewerReasons = makeBlocker({
        displayId: 1,
        hwnd: 1000n,
        pid: 111,
        exeName: null,
        reasons: new Set(['fullscreen']),
        severity: 'hard',
      })
      const moreReasons = makeBlocker({
        displayId: 2,
        hwnd: 2000n,
        pid: 222,
        exeName: 'bad.exe',
        reasons: new Set(['fullscreen', 'user-rule']),
        severity: 'hard',
      })
      const map: DisplayStateMap = new Map([
        [1, fewerReasons],
        [2, moreReasons],
      ])
      const next = validateBlockers(map, rules({ exeName: 'bad.exe', effect: 'hard' }), () => ({ status: 'ok', displayId: 9, isFullscreen: true }))
      expect(next.size).toBe(1)
      expect(next.get(9)).toMatchObject({ hwnd: 2000n })
    })

    it('same severity and reason count: lower pid wins, deterministically regardless of visiting order', () => {
      const higherPid = makeBlocker({ displayId: 1, hwnd: 1000n, pid: 222, reasons: new Set(['fullscreen']), severity: 'hard' })
      const lowerPid = makeBlocker({ displayId: 2, hwnd: 2000n, pid: 111, reasons: new Set(['fullscreen']), severity: 'hard' })

      const mapA: DisplayStateMap = new Map([
        [1, higherPid],
        [2, lowerPid],
      ])
      const mapB: DisplayStateMap = new Map([
        [2, lowerPid],
        [1, higherPid],
      ])
      const probe = (): BlockerProbe => ({ status: 'ok', displayId: 9, isFullscreen: true })

      const nextA = validateBlockers(mapA, NO_RULES, probe)
      const nextB = validateBlockers(mapB, NO_RULES, probe)
      expect(nextA.get(9)).toMatchObject({ pid: 111 })
      expect(nextB.get(9)).toMatchObject({ pid: 111 })
    })
  })
})
