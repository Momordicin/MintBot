import { describe, it, expect } from 'vitest'
import { isVoiceInputMode, nextVoiceInputMode } from './voiceInputMode.js'

describe('nextVoiceInputMode', () => {
  it('cycles off -> listen -> transcribe -> off', () => {
    expect(nextVoiceInputMode('off')).toBe('listen')
    expect(nextVoiceInputMode('listen')).toBe('transcribe')
    expect(nextVoiceInputMode('transcribe')).toBe('off')
  })
})

describe('isVoiceInputMode', () => {
  it('accepts the three modes and rejects everything else', () => {
    expect(isVoiceInputMode('off')).toBe(true)
    expect(isVoiceInputMode('listen')).toBe(true)
    expect(isVoiceInputMode('transcribe')).toBe(true)
    expect(isVoiceInputMode('normal')).toBe(false)
    expect(isVoiceInputMode(true)).toBe(false)
    expect(isVoiceInputMode(undefined)).toBe(false)
  })
})
