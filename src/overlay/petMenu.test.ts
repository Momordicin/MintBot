import { describe, it, expect } from 'vitest'
import { buildMenuState, resolveMenuActionPatch } from './petMenu'
import type { PetMenuLive } from './petMenu'
import type { OverlayManifest } from './portraitState'

const FORM = { fallback: 'neutral', emotions: { neutral: ['a.png'] } }
const BOTH: OverlayManifest = { portraits: { pixel: FORM, illustration: FORM } }
const PIXEL_ONLY: OverlayManifest = { portraits: { pixel: FORM } }

const LIVE: PetMenuLive = {
  presetId: 'p1',
  form: 'pixel',
  manifest: BOTH,
  petScale: { pixel: 1, illustration: 0.75 },
}

describe('buildMenuState', () => {
  it('returns null when preset id, manifest or scale is missing', () => {
    expect(buildMenuState({ ...LIVE, presetId: null })).toBeNull()
    expect(buildMenuState({ ...LIVE, manifest: undefined })).toBeNull()
    expect(buildMenuState({ ...LIVE, petScale: null })).toBeNull()
  })

  it('reports the other form as available when its manifest group is non-empty', () => {
    expect(buildMenuState(LIVE)).toEqual({
      presetId: 'p1',
      effectiveForm: 'pixel',
      otherFormAvailable: true,
      petScale: { pixel: 1, illustration: 0.75 },
    })
  })

  it('reports the other form as unavailable when the manifest lacks it', () => {
    expect(buildMenuState({ ...LIVE, manifest: PIXEL_ONLY })?.otherFormAvailable).toBe(false)
    expect(buildMenuState({ ...LIVE, form: 'illustration', manifest: PIXEL_ONLY })?.otherFormAvailable).toBe(true)
  })
})

describe('resolveMenuActionPatch', () => {
  it('builds the full scale pair, replacing only the acted form', () => {
    expect(resolveMenuActionPatch({ kind: 'set-scale', presetId: 'p1', form: 'pixel', value: 1.5 }, LIVE)).toEqual({
      presetId: 'p1',
      displayConfig: { petScale: { pixel: 1.5, illustration: 0.75 } },
    })
  })

  it('builds a currentPortrait patch for an available target form', () => {
    expect(resolveMenuActionPatch({ kind: 'switch-form', presetId: 'p1', to: 'illustration' }, LIVE)).toEqual({
      presetId: 'p1',
      displayConfig: { currentPortrait: 'illustration' },
    })
  })

  it('rejects an action for another preset', () => {
    expect(resolveMenuActionPatch({ kind: 'set-scale', presetId: 'p2', form: 'pixel', value: 1.5 }, LIVE)).toBeNull()
    expect(resolveMenuActionPatch({ kind: 'switch-form', presetId: 'p2', to: 'illustration' }, LIVE)).toBeNull()
  })

  it('rejects a scale action whose form is no longer the live form', () => {
    expect(resolveMenuActionPatch({ kind: 'set-scale', presetId: 'p1', form: 'illustration', value: 1.5 }, LIVE)).toBeNull()
  })

  it('rejects a switch to the form already shown', () => {
    expect(resolveMenuActionPatch({ kind: 'switch-form', presetId: 'p1', to: 'pixel' }, LIVE)).toBeNull()
  })

  it('rejects a switch to a form the manifest does not provide', () => {
    expect(resolveMenuActionPatch({ kind: 'switch-form', presetId: 'p1', to: 'illustration' }, { ...LIVE, manifest: PIXEL_ONLY })).toBeNull()
  })

  it('rejects everything while live state is missing', () => {
    const action = { kind: 'set-scale', presetId: 'p1', form: 'pixel', value: 1.5 } as const
    expect(resolveMenuActionPatch(action, { ...LIVE, presetId: null })).toBeNull()
    expect(resolveMenuActionPatch(action, { ...LIVE, manifest: undefined })).toBeNull()
    expect(resolveMenuActionPatch(action, { ...LIVE, petScale: null })).toBeNull()
  })
})
