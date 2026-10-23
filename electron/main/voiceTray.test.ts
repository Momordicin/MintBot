import { describe, expect, it, vi } from 'vitest'
import { buildVoiceInputMenu, createVoiceTrayRefresher, parseVoiceTrayState, VOICE_TRAY_UNAVAILABLE } from './voiceTray'

describe('parseVoiceTrayState', () => {
  it('is available only when installed, not installing and in normal mode', () => {
    const base = { installed: true, install: { state: 'idle' }, mode: 'normal', inputMode: 'transcribe' }
    expect(parseVoiceTrayState(base)).toEqual({ inputMode: 'transcribe', available: true })
    expect(parseVoiceTrayState({ ...base, installed: false }).available).toBe(false)
    expect(parseVoiceTrayState({ ...base, install: { state: 'installing' } }).available).toBe(false)
    expect(parseVoiceTrayState({ ...base, mode: 'testing' }).available).toBe(false)
  })

  it('falls back to off for an unknown mode and to unavailable for a bad body', () => {
    expect(parseVoiceTrayState({ installed: true, install: { state: 'idle' }, mode: 'normal', inputMode: 'x' }).inputMode).toBe('off')
    expect(parseVoiceTrayState(null)).toEqual(VOICE_TRAY_UNAVAILABLE)
  })
})

describe('createVoiceTrayRefresher', () => {
  const status = (inputMode: string) => ({ installed: true, install: { state: 'idle' }, mode: 'normal', inputMode })

  it('applies only the latest response when earlier requests resolve after it', async () => {
    const resolvers: Array<(body: unknown) => void> = []
    const apply = vi.fn()
    const refresh = createVoiceTrayRefresher({
      fetchStatus: () => new Promise(resolve => resolvers.push(resolve)),
      apply,
    })

    const first = refresh()
    const second = refresh()
    resolvers[1](status('transcribe'))
    await second
    resolvers[0](status('listen'))
    await first

    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith({ inputMode: 'transcribe', available: true })
  })

  it('applies the unavailable state when the fetch fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const apply = vi.fn()
    await createVoiceTrayRefresher({ fetchStatus: () => Promise.reject(new Error('timeout')), apply })()
    expect(apply).toHaveBeenCalledWith(VOICE_TRAY_UNAVAILABLE)
    errorSpy.mockRestore()
  })
})

describe('buildVoiceInputMenu', () => {
  it('builds a radio group that checks the current mode and calls onSelect', () => {
    const onSelect = vi.fn()
    const menu = buildVoiceInputMenu({ inputMode: 'listen', available: true }, onSelect)
    const items = menu.submenu as Array<{ label: string; type: string; checked: boolean; enabled: boolean; click: () => void }>
    expect(menu.label).toBe('语音输入')
    expect(items.map(i => [i.label, i.type, i.checked, i.enabled])).toEqual([
      ['关闭', 'radio', false, true],
      ['聆听', 'radio', true, true],
      ['转写', 'radio', false, true],
    ])
    items[2].click()
    expect(onSelect).toHaveBeenCalledWith('transcribe')
  })

  it('disables the whole group when voice is unavailable', () => {
    const menu = buildVoiceInputMenu(VOICE_TRAY_UNAVAILABLE, vi.fn())
    expect(menu.enabled).toBe(false)
    expect((menu.submenu as Array<{ enabled: boolean }>).every(i => i.enabled === false)).toBe(true)
  })
})
