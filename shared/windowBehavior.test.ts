import { describe, it, expect } from 'vitest'
import { isNewerSnapshot, type WindowBehaviorSnapshot } from './windowBehavior.js'

function snapshot(generation: string, revision: number): WindowBehaviorSnapshot {
  return { generation, revision, config: { chatPinMode: 'off', petAvoidanceEnabled: true, appRules: [] } }
}

describe('isNewerSnapshot', () => {
  it('accepts any snapshot when there is no previous one', () => {
    expect(isNewerSnapshot(null, snapshot('g1', 1))).toBe(true)
  })

  it('accepts a higher revision of the same generation', () => {
    expect(isNewerSnapshot(snapshot('g1', 2), snapshot('g1', 3))).toBe(true)
  })

  it('rejects an equal revision of the same generation', () => {
    expect(isNewerSnapshot(snapshot('g1', 2), snapshot('g1', 2))).toBe(false)
  })

  it('rejects a lower revision of the same generation', () => {
    expect(isNewerSnapshot(snapshot('g1', 5), snapshot('g1', 4))).toBe(false)
  })

  it('accepts a different generation even when the revision is lower', () => {
    expect(isNewerSnapshot(snapshot('g1', 9), snapshot('g2', 1))).toBe(true)
  })
})
