import { describe, it, expect } from 'vitest'
import { buildPetMenu, parsePetMenuState } from './petContextMenu'
import type { PetMenuState } from './petContextMenu'
import type { WindowBehaviorConfig } from '../../shared/windowBehavior.js'

const CONFIG: WindowBehaviorConfig = {
  chatPinMode: 'off',
  petAvoidanceEnabled: true,
  petClickThrough: false,
  petCollapsed: false,
  appRules: [],
}

const STATE: PetMenuState = {
  presetId: 'p1',
  effectiveForm: 'pixel',
  otherFormAvailable: true,
  petScale: { pixel: 1.25, illustration: 0.75 },
}

describe('buildPetMenu', () => {
  it('collapsed mode offers only the show item', () => {
    expect(buildPetMenu('collapsed', { ...CONFIG, petCollapsed: true }, STATE)).toEqual([
      { label: '显示悬浮窗', action: { kind: 'set-collapsed', value: false } },
    ])
  })

  it('lists the five items in order in normal mode', () => {
    const items = buildPetMenu('normal', CONFIG, STATE)
    expect(items.map(item => item.label)).toEqual(['窗口可穿透', '窗口大小', '桌宠智能避让', '切换至立绘', '隐藏悬浮窗'])
  })

  it('reflects click-through and avoidance as checkboxes whose action flips the value', () => {
    const items = buildPetMenu('clickThrough', { ...CONFIG, petClickThrough: true, petAvoidanceEnabled: false }, STATE)
    expect(items[0]).toMatchObject({ type: 'checkbox', checked: true, action: { kind: 'set-click-through', value: false } })
    expect(items[2]).toMatchObject({ type: 'checkbox', checked: false, action: { kind: 'set-avoidance', value: true } })
  })

  it('size submenu is five radios with the current form scale checked', () => {
    const sizes = buildPetMenu('normal', CONFIG, STATE)[1].submenu!
    expect(sizes.map(item => item.label)).toEqual(['50%', '75%', '100%', '125%', '150%'])
    expect(sizes.map(item => item.checked)).toEqual([false, false, false, true, false])
    expect(sizes.every(item => item.type === 'radio' && item.enabled === true)).toBe(true)
    expect(sizes[0].action).toEqual({ kind: 'set-scale', value: 0.5 })
  })

  it('checks the scale of the illustration form when that is the effective form', () => {
    const sizes = buildPetMenu('normal', CONFIG, { ...STATE, effectiveForm: 'illustration' })[1].submenu!
    expect(sizes.map(item => item.checked)).toEqual([false, true, false, false, false])
  })

  it('offers the pixel switch while in illustration form', () => {
    const item = buildPetMenu('normal', CONFIG, { ...STATE, effectiveForm: 'illustration' })[3]
    expect(item).toEqual({ label: '切换至像素', action: { kind: 'switch-form', form: 'pixel' } })
  })

  it('disables the form item with an explanatory label when the other form is missing', () => {
    expect(buildPetMenu('normal', CONFIG, { ...STATE, otherFormAvailable: false })[3]).toEqual({ label: '该角色没有立绘', enabled: false })
    expect(
      buildPetMenu('normal', CONFIG, { ...STATE, effectiveForm: 'illustration', otherFormAvailable: false })[3]
    ).toEqual({ label: '该角色没有像素', enabled: false })
  })

  it('disables the size submenu and form item when no menu state was reported yet', () => {
    const items = buildPetMenu('normal', CONFIG, null)
    expect(items[1].enabled).toBe(false)
    expect(items[1].submenu!.every(item => item.enabled === false && item.checked === false)).toBe(true)
    expect(items[3].enabled).toBe(false)
    expect(items[3].action).toBeUndefined()
  })

  it('hide item sets collapsed true', () => {
    expect(buildPetMenu('normal', CONFIG, STATE)[4].action).toEqual({ kind: 'set-collapsed', value: true })
  })
})

describe('parsePetMenuState', () => {
  it('accepts a well-formed payload', () => {
    expect(parsePetMenuState({ ...STATE })).toEqual(STATE)
  })

  it('rejects non-objects, bad ids, bad forms, bad flags and out-of-range scales', () => {
    expect(parsePetMenuState(null)).toBeNull()
    expect(parsePetMenuState('x')).toBeNull()
    expect(parsePetMenuState({ ...STATE, presetId: '' })).toBeNull()
    expect(parsePetMenuState({ ...STATE, presetId: 3 })).toBeNull()
    expect(parsePetMenuState({ ...STATE, effectiveForm: 'other' })).toBeNull()
    expect(parsePetMenuState({ ...STATE, otherFormAvailable: 'yes' })).toBeNull()
    expect(parsePetMenuState({ ...STATE, petScale: null })).toBeNull()
    expect(parsePetMenuState({ ...STATE, petScale: { pixel: 1 } })).toBeNull()
    expect(parsePetMenuState({ ...STATE, petScale: { pixel: 1, illustration: 3 } })).toBeNull()
  })

  it('drops unknown extra fields', () => {
    expect(parsePetMenuState({ ...STATE, extra: 1 })).toEqual(STATE)
  })
})
