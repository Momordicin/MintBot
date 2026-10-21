import { describe, expect, it } from 'vitest'
import { deviceLineBetween, summarizeVoiceTest, testCutoff } from './voiceTestSummary.js'

describe('testCutoff', () => {
  it('uses the status floor for a short utterance on the enrollment device', () => {
    expect(testCutoff({ score: 0.4, threshold: 0.5, uncertain: true, sameDevice: true }, 0.3)).toBe(0.3)
  })

  it('uses the reported threshold for a normal utterance on the enrollment device', () => {
    expect(testCutoff({ score: 0.6, threshold: 0.5, uncertain: false, sameDevice: true }, 0.3)).toBe(0.5)
  })

  it('uses the reported threshold on another device, short or normal', () => {
    expect(testCutoff({ score: 0.4, threshold: 0.35, uncertain: true, sameDevice: false }, 0.3)).toBe(0.35)
    expect(testCutoff({ score: 0.4, threshold: 0.35, uncertain: false, sameDevice: false }, 0.3)).toBe(0.35)
  })

  it('returns null instead of guessing when a field is missing', () => {
    expect(testCutoff({ threshold: 0.5, uncertain: false }, 0.3)).toBeNull()
    expect(testCutoff({ score: 0.4, uncertain: false }, 0.3)).toBeNull()
    expect(testCutoff({ score: 0.4, threshold: 0.5, uncertain: true }, 0.3)).toBeNull()
    expect(testCutoff({ score: 0.4, threshold: 0.5, uncertain: true, sameDevice: true }, null)).toBeNull()
    expect(testCutoff({ score: 0.4, uncertain: true, sameDevice: false }, 0.3)).toBeNull()
  })
})

describe('deviceLineBetween', () => {
  it('shows the mic line before the first result', () => {
    expect(deviceLineBetween(null, { deviceName: 'A', sameDevice: true })).toEqual({ to: { name: 'A', sameDevice: true } })
  })

  it('shows nothing when the mic is unchanged', () => {
    expect(deviceLineBetween({ deviceName: 'A', sameDevice: true }, { deviceName: 'A', sameDevice: true })).toBeNull()
  })

  it('shows a change line when the name changes', () => {
    expect(deviceLineBetween({ deviceName: 'A', sameDevice: true }, { deviceName: 'B', sameDevice: false })).toEqual({
      from: { name: 'A', sameDevice: true },
      to: { name: 'B', sameDevice: false },
    })
  })

  it('shows a change line when only sameDevice changes', () => {
    expect(deviceLineBetween({ deviceName: 'A', sameDevice: true }, { deviceName: 'A', sameDevice: false })).toEqual({
      from: { name: 'A', sameDevice: true },
      to: { name: 'A', sameDevice: false },
    })
  })

  it('handles missing names and sameDevice', () => {
    expect(deviceLineBetween(null, {})).toBeNull()
    expect(deviceLineBetween({ deviceName: 'A' }, {})).toBeNull()
    expect(deviceLineBetween({}, { deviceName: 'B', sameDevice: true })).toEqual({ to: { name: 'B', sameDevice: true } })
    expect(deviceLineBetween({ deviceName: 'A' }, { deviceName: 'A' })).toBeNull()
    expect(deviceLineBetween({ deviceName: 'A', sameDevice: true }, { deviceName: 'A' })).toEqual({
      from: { name: 'A', sameDevice: true },
      to: { name: 'A', sameDevice: undefined },
    })
  })
})

describe('summarizeVoiceTest', () => {
  it('returns zero counts and null scores for no results', () => {
    expect(summarizeVoiceTest([])).toEqual({
      ownerCount: 0,
      otherCount: 0,
      minScore: null,
      medianScore: null,
      maxScore: null,
    })
  })

  it('counts owner and treats every other kind as other', () => {
    const summary = summarizeVoiceTest([
      { kind: 'owner', score: 0.9 },
      { kind: 'other', score: 0.2 },
      { kind: 'unenrolled' },
      { kind: 'owner' },
    ])
    expect(summary.ownerCount).toBe(2)
    expect(summary.otherCount).toBe(2)
  })

  it('uses only scored results, sorted ascending, with min / median / max indices', () => {
    const summary = summarizeVoiceTest([
      { kind: 'owner', score: 0.8 },
      { kind: 'other' },
      { kind: 'other', score: 0.1 },
      { kind: 'owner', score: 0.5 },
      { kind: 'owner', score: 0.9 },
    ])
    expect(summary.minScore).toBe(0.1)
    expect(summary.medianScore).toBe(0.8)
    expect(summary.maxScore).toBe(0.9)
  })

  it('handles a single score and an even number of scores', () => {
    expect(summarizeVoiceTest([{ kind: 'owner', score: 0.4 }])).toMatchObject({
      minScore: 0.4,
      medianScore: 0.4,
      maxScore: 0.4,
    })
    const even = summarizeVoiceTest([
      { kind: 'owner', score: 0.1 },
      { kind: 'owner', score: 0.2 },
      { kind: 'owner', score: 0.3 },
      { kind: 'owner', score: 0.4 },
    ])
    expect(even.medianScore).toBe(0.3)
    expect(even.maxScore).toBe(0.4)
  })
})
