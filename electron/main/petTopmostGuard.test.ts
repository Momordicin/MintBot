import { describe, it, expect } from 'vitest'
import { evaluatePetTopmost, shouldLogRepair } from './petTopmostGuard'
import type { WindowAboveState } from './petTopmostGuard'

function above(overrides: Partial<WindowAboveState> = {}): WindowAboveState {
  return { hwnd: 1n, visible: true, cloaked: false, iconic: false, emptyRect: false, topmost: false, ...overrides }
}

describe('evaluatePetTopmost', () => {
  it('is buried when the pet own topmost bit is missing, even with nothing above', () => {
    expect(evaluatePetTopmost(false, [])).toEqual({ buried: true, reason: 'own-bit-missing' })
  })

  it('reports the first visible ordinary window above the pet', () => {
    const first = above({ hwnd: 10n })
    const second = above({ hwnd: 20n })
    expect(evaluatePetTopmost(true, [above({ topmost: true }), first, second])).toEqual({
      buried: true,
      reason: 'covered',
      offender: first,
    })
  })

  it('is not buried when only topmost windows are above', () => {
    expect(evaluatePetTopmost(true, [above({ topmost: true }), above({ topmost: true })])).toEqual({ buried: false })
  })

  it('ignores cloaked, iconic, empty-rect and invisible ordinary windows', () => {
    expect(
      evaluatePetTopmost(true, [above({ cloaked: true }), above({ iconic: true }), above({ emptyRect: true }), above({ visible: false })])
    ).toEqual({ buried: false })
  })

  it('is not buried when nothing is above', () => {
    expect(evaluatePetTopmost(true, [])).toEqual({ buried: false })
  })
})

describe('shouldLogRepair', () => {
  it('logs the first repair', () => {
    expect(shouldLogRepair(null, 1000)).toBe(true)
  })

  it('suppresses repairs within 60 seconds of the last line', () => {
    expect(shouldLogRepair(1000, 60_999)).toBe(false)
  })

  it('logs again once 60 seconds have passed', () => {
    expect(shouldLogRepair(1000, 61_000)).toBe(true)
  })
})
