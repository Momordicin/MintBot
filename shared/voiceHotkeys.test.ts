import { describe, expect, it } from 'vitest'
import { acceleratorFromKeyEvent, normalizeVoiceHotkey, resolveHotkeyCapture } from './voiceHotkeys.js'

const event = (code: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}) => ({
  code,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
  metaKey: mods.meta ?? false,
})

describe('acceleratorFromKeyEvent', () => {
  it('joins modifiers in Ctrl, Alt, Shift order before the key', () => {
    expect(acceleratorFromKeyEvent(event('KeyL', { ctrl: true, alt: true }))).toBe('Ctrl+Alt+L')
    expect(acceleratorFromKeyEvent(event('KeyA', { shift: true, ctrl: true, alt: true }))).toBe('Ctrl+Alt+Shift+A')
  })

  it('maps digits, function keys and named keys', () => {
    expect(acceleratorFromKeyEvent(event('Digit5', { ctrl: true }))).toBe('Ctrl+5')
    expect(acceleratorFromKeyEvent(event('F12', { alt: true }))).toBe('Alt+F12')
    expect(acceleratorFromKeyEvent(event('ArrowUp', { ctrl: true }))).toBe('Ctrl+Up')
    expect(acceleratorFromKeyEvent(event('Enter', { ctrl: true }))).toBe('Ctrl+Return')
    expect(acceleratorFromKeyEvent(event('Space', { alt: true }))).toBe('Alt+Space')
  })

  it('returns the bare key when no modifier is held so the caller can reject it', () => {
    expect(acceleratorFromKeyEvent(event('KeyL'))).toBe('L')
  })

  it('ignores modifier-only, unsupported and Win-key presses', () => {
    expect(acceleratorFromKeyEvent(event('ControlLeft', { ctrl: true }))).toBeNull()
    expect(acceleratorFromKeyEvent(event('ShiftRight', { shift: true }))).toBeNull()
    expect(acceleratorFromKeyEvent(event('Escape', { ctrl: true }))).toBeNull()
    expect(acceleratorFromKeyEvent(event('KeyL', { ctrl: true, meta: true }))).toBeNull()
  })
})

describe('normalizeVoiceHotkey', () => {
  it('accepts modifier plus key and canonicalises modifier order', () => {
    expect(normalizeVoiceHotkey('Ctrl+Alt+L')).toBe('Ctrl+Alt+L')
    expect(normalizeVoiceHotkey('Shift+Alt+Ctrl+F5')).toBe('Ctrl+Alt+Shift+F5')
  })

  it('rejects no modifier, modifiers only, repeated or unknown parts and non-strings', () => {
    expect(normalizeVoiceHotkey('L')).toBeNull()
    expect(normalizeVoiceHotkey('Ctrl+Alt')).toBeNull()
    expect(normalizeVoiceHotkey('Ctrl+Ctrl+L')).toBeNull()
    expect(normalizeVoiceHotkey('Super+L')).toBeNull()
    expect(normalizeVoiceHotkey('Ctrl+')).toBeNull()
    expect(normalizeVoiceHotkey('')).toBeNull()
    expect(normalizeVoiceHotkey(5)).toBeNull()
  })
})

describe('resolveHotkeyCapture', () => {
  const down = (code: string, mods: Parameters<typeof event>[1] = {}) => ({ type: 'keydown' as const, ...event(code, mods) })
  const up = (code: string, mods: Parameters<typeof event>[1] = {}) => ({ type: 'keyup' as const, ...event(code, mods) })

  it('stays pending while any key is still held', () => {
    expect(resolveHotkeyCapture([])).toEqual({ status: 'pending' })
    expect(resolveHotkeyCapture([down('ControlLeft', { ctrl: true }), down('KeyL', { ctrl: true })])).toEqual({ status: 'pending' })
  })

  it('yields no combo when only modifiers arrived', () => {
    expect(resolveHotkeyCapture([
      down('ControlLeft', { ctrl: true }),
      down('AltLeft', { ctrl: true, alt: true }),
      up('AltLeft', { ctrl: true }),
      up('ControlLeft'),
    ])).toEqual({ status: 'done', accelerator: null })
  })

  it('yields the combo once every key is released', () => {
    expect(resolveHotkeyCapture([
      down('ControlLeft', { ctrl: true }),
      down('AltLeft', { ctrl: true, alt: true }),
      down('KeyL', { ctrl: true, alt: true }),
      up('KeyL', { ctrl: true, alt: true }),
      up('AltLeft', { ctrl: true }),
      up('ControlLeft'),
    ])).toEqual({ status: 'done', accelerator: 'Ctrl+Alt+L' })
  })

  it('keeps the last combo when the key changes mid-way', () => {
    expect(resolveHotkeyCapture([
      down('ControlLeft', { ctrl: true }),
      down('KeyL', { ctrl: true }),
      up('KeyL', { ctrl: true }),
      down('KeyT', { ctrl: true }),
      up('KeyT', { ctrl: true }),
      up('ControlLeft'),
    ])).toEqual({ status: 'done', accelerator: 'Ctrl+T' })
  })

  it('ignores key releases that precede the first key press', () => {
    expect(resolveHotkeyCapture([up('Enter'), down('ControlLeft', { ctrl: true })])).toEqual({ status: 'pending' })
  })

  it('cancels on Escape', () => {
    expect(resolveHotkeyCapture([down('ControlLeft', { ctrl: true }), down('Escape', { ctrl: true })])).toEqual({ status: 'cancelled' })
  })
})
