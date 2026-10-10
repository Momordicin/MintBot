import { describe, it, expect } from 'vitest'
import { isPortraitFormAvailable, resolveEffectiveForm } from './portraitForm.js'

const available = { fallback: 'idle', emotions: { idle: ['a.png'] } }

describe('isPortraitFormAvailable', () => {
  it('is available when the fallback group is non-empty', () => {
    expect(isPortraitFormAvailable(available)).toBe(true)
  })

  it('is unavailable when the fallback group is empty', () => {
    expect(isPortraitFormAvailable({ fallback: 'idle', emotions: { idle: [] } })).toBe(false)
  })

  it('is unavailable when the fallback group is missing from emotions', () => {
    expect(isPortraitFormAvailable({ fallback: 'idle', emotions: { happy: ['a.png'] } })).toBe(false)
  })

  it('is unavailable when fallback, emotions or the form itself is missing', () => {
    expect(isPortraitFormAvailable({ fallback: '', emotions: { idle: ['a.png'] } })).toBe(false)
    expect(isPortraitFormAvailable({ emotions: { idle: ['a.png'] } })).toBe(false)
    expect(isPortraitFormAvailable({ fallback: 'idle' })).toBe(false)
    expect(isPortraitFormAvailable(undefined)).toBe(false)
  })
})

describe('resolveEffectiveForm', () => {
  const unavailable = { fallback: 'idle', emotions: { idle: [] } }

  it('uses the saved form when it is available', () => {
    expect(resolveEffectiveForm('illustration', { pixel: available, illustration: available })).toBe('illustration')
  })

  it('uses the other form when the saved one is unavailable', () => {
    expect(resolveEffectiveForm('illustration', { pixel: available, illustration: unavailable })).toBe('pixel')
    expect(resolveEffectiveForm('pixel', { illustration: available })).toBe('illustration')
  })

  it('returns null when neither form is available', () => {
    expect(resolveEffectiveForm('pixel', { pixel: unavailable, illustration: unavailable })).toBeNull()
    expect(resolveEffectiveForm('pixel', undefined)).toBeNull()
  })
})
