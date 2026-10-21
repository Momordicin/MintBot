import { describe, expect, it } from 'vitest'
import { summarizeVoiceTest, testCutoff } from './voiceTestSummary.js'

describe('testCutoff', () => {
  it('uses the reported threshold for normal-length utterances', () => {
    expect(testCutoff(0.5, false)).toBe(0.5)
    expect(testCutoff(0.25, false)).toBe(0.25)
  })

  it('uses the short-utterance floor derived from the threshold', () => {
    expect(testCutoff(0.5, true)).toBe(0.3)
    expect(testCutoff(0.25, true)).toBeCloseTo(0.275, 10)
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
