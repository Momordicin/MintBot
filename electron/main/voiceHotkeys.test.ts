import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVoiceHotkeys, createVoiceHotkeysFileIo, nextModeForHotkey } from './voiceHotkeys'
import type { VoiceInputMode } from '../../shared/voiceInputMode.js'

const AVAILABLE = { installed: true, install: { state: 'idle' }, mode: 'normal' }

function setup(options: { file?: string | null; taken?: string[]; status?: unknown; switchResult?: boolean } = {}) {
  const taken = new Set(options.taken ?? [])
  const active = new Map<string, () => void>()
  const globalShortcut = {
    register: vi.fn((accelerator: string, callback: () => void) => {
      if (taken.has(accelerator) || active.has(accelerator)) return false
      active.set(accelerator, callback)
      return true
    }),
    unregister: vi.fn((accelerator: string) => {
      active.delete(accelerator)
    }),
  }
  const notify = vi.fn()
  let file = options.file ?? null
  const io = {
    read: vi.fn(() => {
      if (file === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return file
    }),
    write: vi.fn((content: string) => {
      file = content
    }),
  }
  const fetchStatus = vi.fn(async () => options.status ?? { ...AVAILABLE, inputMode: 'off' })
  const switchMode = vi.fn(async (_mode: VoiceInputMode) => options.switchResult ?? true)
  const clock = { value: 10_000 }
  const hotkeys = createVoiceHotkeys({ globalShortcut, notify, io, fetchStatus, now: () => clock.value, switchMode })
  return { hotkeys, active, globalShortcut, notify, io, fetchStatus, switchMode, taken, clock, getFile: () => file }
}

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
})

describe('nextModeForHotkey', () => {
  const cases: Array<[VoiceInputMode, 'listen' | 'transcribe', VoiceInputMode]> = [
    ['off', 'listen', 'listen'],
    ['listen', 'listen', 'off'],
    ['transcribe', 'listen', 'listen'],
    ['off', 'transcribe', 'transcribe'],
    ['listen', 'transcribe', 'transcribe'],
    ['transcribe', 'transcribe', 'off'],
  ]
  it.each(cases)('current %s, pressed %s -> %s', (current, pressed, expected) => {
    expect(nextModeForHotkey(current, pressed)).toBe(expected)
  })
})

describe('key press', () => {
  it('switches mode through the core and notifies the new mode', async () => {
    const { hotkeys, active, switchMode, notify } = setup({ status: { ...AVAILABLE, inputMode: 'listen' } })
    hotkeys.start()
    active.get('Ctrl+Alt+L')?.()
    await vi.waitFor(() => expect(notify).toHaveBeenCalled())
    expect(switchMode).toHaveBeenCalledWith('off')
    expect(notify).toHaveBeenCalledWith('MintBot', '语音输入：已关闭')
  })

  it('notifies the transcribe and listen modes', async () => {
    const { hotkeys, notify, switchMode, clock } = setup()
    hotkeys.start()
    await hotkeys.press('transcribe')
    clock.value += 1000
    await hotkeys.press('listen')
    expect(switchMode.mock.calls.map(call => call[0])).toEqual(['transcribe', 'listen'])
    expect(notify.mock.calls.map(call => call[1])).toEqual(['语音输入：转写', '语音输入：聆听'])
  })

  it('only notifies when voice input is unavailable and sends no switch request', async () => {
    const { hotkeys, notify, switchMode } = setup({ status: { ...AVAILABLE, installed: false } })
    await hotkeys.press('listen')
    expect(switchMode).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('MintBot', '语音输入当前不可用')
  })

  it('notifies unavailable while enrolling or testing', async () => {
    const { hotkeys, notify, switchMode } = setup({ status: { ...AVAILABLE, mode: 'testing' } })
    await hotkeys.press('transcribe')
    expect(switchMode).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('MintBot', '语音输入当前不可用')
  })

  it('notifies unavailable when the core rejects the switch with 409 or 503', async () => {
    const { hotkeys, notify, switchMode } = setup({ switchResult: false })
    await hotkeys.press('listen')
    expect(switchMode).toHaveBeenCalledWith('listen')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('MintBot', '语音输入当前不可用')
  })

  it('notifies unavailable and logs when the status fetch fails', async () => {
    const { hotkeys, notify, fetchStatus, switchMode } = setup()
    fetchStatus.mockRejectedValueOnce(new Error('down'))
    await hotkeys.press('listen')
    expect(switchMode).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('MintBot', '语音输入当前不可用')
    expect(errorSpy).toHaveBeenCalled()
  })
})

describe('startup registration', () => {
  it('registers the default hotkeys when the file is missing and does not create it', () => {
    const { hotkeys, active, io, notify } = setup()
    hotkeys.start()
    expect([...active.keys()].sort()).toEqual(['Ctrl+Alt+L', 'Ctrl+Alt+T'])
    expect(io.write).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(hotkeys.get()).toEqual({
      listen: 'Ctrl+Alt+L',
      transcribe: 'Ctrl+Alt+T',
      listenRegistered: true,
      transcribeRegistered: true,
    })
  })

  it('uses the stored hotkeys', () => {
    const { hotkeys, active } = setup({ file: JSON.stringify({ listen: 'Ctrl+Shift+F1', transcribe: 'Alt+F2' }) })
    hotkeys.start()
    expect([...active.keys()].sort()).toEqual(['Alt+F2', 'Ctrl+Shift+F1'])
  })

  it.each([
    ['unparsable JSON', '{nope'],
    ['a key without a modifier', JSON.stringify({ listen: 'L', transcribe: 'Ctrl+Alt+T' })],
    ['a missing field', JSON.stringify({ listen: 'Ctrl+Alt+L' })],
    ['duplicate hotkeys', JSON.stringify({ listen: 'Ctrl+Alt+L', transcribe: 'Ctrl+Alt+L' })],
  ])('falls back to the defaults for %s without overwriting the file', (_name, content) => {
    const { hotkeys, active, io, getFile } = setup({ file: content })
    hotkeys.start()
    expect([...active.keys()].sort()).toEqual(['Ctrl+Alt+L', 'Ctrl+Alt+T'])
    expect(io.write).not.toHaveBeenCalled()
    expect(getFile()).toBe(content)
    expect(errorSpy).toHaveBeenCalled()
  })

  it('notifies once for a key that cannot be registered, logs an error and empties and saves it', () => {
    const { hotkeys, notify, active, getFile } = setup({ taken: ['Ctrl+Alt+T'] })
    hotkeys.start()
    expect(hotkeys.get().transcribe).toBe('')
    expect(JSON.parse(getFile() as string)).toEqual({ listen: 'Ctrl+Alt+L', transcribe: '' })
    expect(active.has('Ctrl+Alt+L')).toBe(true)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('MintBot', '快捷键 Ctrl+Alt+T 已被其他程序占用，无法使用')
    expect(errorSpy).toHaveBeenCalled()
    expect(hotkeys.get().transcribeRegistered).toBe(false)
    expect(hotkeys.get().listenRegistered).toBe(true)
  })

  it('keeps a stored empty key empty, never registers it and does not notify', () => {
    const { hotkeys, active, io, notify } = setup({ file: JSON.stringify({ listen: '', transcribe: 'Alt+F2' }) })
    hotkeys.start()
    expect([...active.keys()]).toEqual(['Alt+F2'])
    expect(hotkeys.get()).toEqual({ listen: '', transcribe: 'Alt+F2', listenRegistered: false, transcribeRegistered: true })
    expect(io.write).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('does not treat two empty keys as duplicates', () => {
    const { hotkeys, active } = setup({ file: JSON.stringify({ listen: '', transcribe: '' }) })
    hotkeys.start()
    expect(hotkeys.get()).toMatchObject({ listen: '', transcribe: '' })
    expect(active.size).toBe(0)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('writes the emptied key when the file is simply missing', () => {
    const { hotkeys, io } = setup({ taken: ['Ctrl+Alt+T'] })
    hotkeys.start()
    expect(io.write).toHaveBeenCalledTimes(1)
  })

  it('keeps the key empty when saving the emptied key fails', () => {
    const { hotkeys, io } = setup({ taken: ['Ctrl+Alt+T'] })
    io.write.mockImplementationOnce(() => {
      throw new Error('disk')
    })
    hotkeys.start()
    expect(hotkeys.get().transcribe).toBe('')
  })

  it('stop unregisters both hotkeys', () => {
    const { hotkeys, active } = setup()
    hotkeys.start()
    hotkeys.stop()
    expect(active.size).toBe(0)
  })
})

describe('set', () => {
  it('registers the new key, saves it and releases the old one', () => {
    const { hotkeys, active, getFile } = setup()
    hotkeys.start()
    const result = hotkeys.set({ listen: 'Ctrl+Shift+K' })
    expect(result.ok).toBe(true)
    expect(result.state.listen).toBe('Ctrl+Shift+K')
    expect(active.has('Ctrl+Alt+L')).toBe(false)
    expect(active.has('Ctrl+Shift+K')).toBe(true)
    expect(active.has('Ctrl+Alt+T')).toBe(true)
    expect(JSON.parse(getFile() as string)).toEqual({ listen: 'Ctrl+Shift+K', transcribe: 'Ctrl+Alt+T' })
  })

  it('rejects a key without a modifier and keeps the old key working', () => {
    const { hotkeys, active, io } = setup()
    hotkeys.start()
    const result = hotkeys.set({ listen: 'K' })
    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
    expect(active.has('Ctrl+Alt+L')).toBe(true)
    expect(io.write).not.toHaveBeenCalled()
  })

  it('rejects modifiers only and non-string input', () => {
    const { hotkeys } = setup()
    hotkeys.start()
    expect(hotkeys.set({ listen: 'Ctrl+Alt' })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(hotkeys.set({ listen: 5 })).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('rejects the same key as the other hotkey and keeps the old key working', () => {
    const { hotkeys, active, io } = setup()
    hotkeys.start()
    const result = hotkeys.set({ listen: 'Alt+Ctrl+T' })
    expect(result).toMatchObject({ ok: false, reason: 'duplicate' })
    expect(active.has('Ctrl+Alt+L')).toBe(true)
    expect(io.write).not.toHaveBeenCalled()
  })

  it('reports taken when registration fails and keeps the old key working', () => {
    const { hotkeys, active, io } = setup({ taken: ['Ctrl+Shift+K'] })
    hotkeys.start()
    const result = hotkeys.set({ listen: 'Ctrl+Shift+K' })
    expect(result).toMatchObject({ ok: false, reason: 'taken' })
    expect(result.state.listen).toBe('Ctrl+Alt+L')
    expect(active.has('Ctrl+Alt+L')).toBe(true)
    expect(io.write).not.toHaveBeenCalled()
  })

  it('swaps both keys in one call', () => {
    const { hotkeys, active } = setup()
    hotkeys.start()
    const result = hotkeys.set({ listen: 'Ctrl+Alt+T', transcribe: 'Ctrl+Alt+L' })
    expect(result.ok).toBe(true)
    expect(result.state).toMatchObject({ listen: 'Ctrl+Alt+T', transcribe: 'Ctrl+Alt+L' })
    expect([...active.keys()].sort()).toEqual(['Ctrl+Alt+L', 'Ctrl+Alt+T'])
  })

  it('restores the old keys when a later key in the same call fails', () => {
    const { hotkeys, active } = setup({ taken: ['Ctrl+Shift+K'] })
    hotkeys.start()
    const result = hotkeys.set({ listen: 'Ctrl+Shift+J', transcribe: 'Ctrl+Shift+K' })
    expect(result).toMatchObject({ ok: false, reason: 'taken' })
    expect([...active.keys()].sort()).toEqual(['Ctrl+Alt+L', 'Ctrl+Alt+T'])
  })

  it('restores the old key and rethrows when saving fails', () => {
    const { hotkeys, active, io } = setup()
    hotkeys.start()
    io.write.mockImplementationOnce(() => {
      throw new Error('disk')
    })
    expect(() => hotkeys.set({ listen: 'Ctrl+Shift+K' })).toThrow('disk')
    expect(active.has('Ctrl+Alt+L')).toBe(true)
    expect(active.has('Ctrl+Shift+K')).toBe(false)
    expect(hotkeys.get().listen).toBe('Ctrl+Alt+L')
  })

  it('retries registering an unchanged key that was taken at startup', () => {
    const { hotkeys, taken, active } = setup({ taken: ['Ctrl+Alt+T'] })
    hotkeys.start()
    taken.clear()
    const result = hotkeys.set({ transcribe: 'Ctrl+Alt+T' })
    expect(result.ok).toBe(true)
    expect(result.state.transcribeRegistered).toBe(true)
    expect(active.has('Ctrl+Alt+T')).toBe(true)
  })
})

describe('set on an empty key', () => {
  const emptyListen = JSON.stringify({ listen: '', transcribe: 'Ctrl+Alt+T' })

  it('registers and saves a new combo', () => {
    const { hotkeys, active, getFile } = setup({ file: emptyListen })
    hotkeys.start()
    const result = hotkeys.set({ listen: 'Ctrl+Shift+K' })
    expect(result.ok).toBe(true)
    expect(result.state).toMatchObject({ listen: 'Ctrl+Shift+K', listenRegistered: true })
    expect(active.has('Ctrl+Shift+K')).toBe(true)
    expect(JSON.parse(getFile() as string)).toEqual({ listen: 'Ctrl+Shift+K', transcribe: 'Ctrl+Alt+T' })
  })

  it('registers the default when restored', () => {
    const { hotkeys, active } = setup({ file: emptyListen })
    hotkeys.start()
    const result = hotkeys.set({ listen: 'Ctrl+Alt+L' })
    expect(result.ok).toBe(true)
    expect(result.state).toMatchObject({ listen: 'Ctrl+Alt+L', listenRegistered: true })
    expect(active.has('Ctrl+Alt+L')).toBe(true)
  })

  it('reports taken when the restored default is still taken and stays empty', () => {
    const { hotkeys } = setup({ file: emptyListen, taken: ['Ctrl+Alt+L'] })
    hotkeys.start()
    const result = hotkeys.set({ listen: 'Ctrl+Alt+L' })
    expect(result).toMatchObject({ ok: false, reason: 'taken' })
    expect(result.state.listen).toBe('')
  })
})

describe('press throttle', () => {
  it('handles only the first of repeated presses within one second', async () => {
    const { hotkeys, fetchStatus, clock } = setup()
    await hotkeys.press('listen')
    clock.value += 400
    await hotkeys.press('listen')
    clock.value += 599
    await hotkeys.press('listen')
    expect(fetchStatus).toHaveBeenCalledTimes(1)
  })

  it('drops alternating presses of the other key silently', async () => {
    const { hotkeys, fetchStatus, switchMode, notify, clock } = setup()
    await hotkeys.press('listen')
    clock.value += 100
    await hotkeys.press('transcribe')
    expect(fetchStatus).toHaveBeenCalledTimes(1)
    expect(switchMode).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('does not extend the window with dropped presses', async () => {
    const { hotkeys, fetchStatus, clock } = setup()
    await hotkeys.press('listen')
    clock.value += 900
    await hotkeys.press('listen')
    clock.value += 100
    await hotkeys.press('listen')
    expect(fetchStatus).toHaveBeenCalledTimes(2)
  })

  it('handles a press after one second', async () => {
    const { hotkeys, switchMode, clock } = setup()
    await hotkeys.press('listen')
    clock.value += 1000
    await hotkeys.press('transcribe')
    expect(switchMode.mock.calls.map(call => call[0])).toEqual(['listen', 'transcribe'])
  })
})

describe('capture', () => {
  it('unregisters both hotkeys on start and registers them again on end', () => {
    const { hotkeys, active } = setup()
    hotkeys.start()
    hotkeys.setCapture(true)
    expect(active.size).toBe(0)
    expect(hotkeys.get().listenRegistered).toBe(true)
    hotkeys.setCapture(false)
    expect([...active.keys()].sort()).toEqual(['Ctrl+Alt+L', 'Ctrl+Alt+T'])
  })

  it('ending a capture that never started does nothing', () => {
    const { hotkeys, globalShortcut } = setup()
    hotkeys.start()
    const calls = globalShortcut.register.mock.calls.length
    hotkeys.setCapture(false)
    expect(globalShortcut.register.mock.calls.length).toBe(calls)
  })

  it('a key set during capture takes effect after the capture ends', () => {
    const { hotkeys, active } = setup()
    hotkeys.start()
    hotkeys.setCapture(true)
    const result = hotkeys.set({ listen: 'Ctrl+Shift+K' })
    expect(result.ok).toBe(true)
    expect(active.size).toBe(0)
    hotkeys.setCapture(false)
    expect([...active.keys()].sort()).toEqual(['Ctrl+Alt+T', 'Ctrl+Shift+K'])
  })

  it('marks a key unregistered when it cannot be restored after capture', () => {
    const { hotkeys, taken } = setup()
    hotkeys.start()
    hotkeys.setCapture(true)
    taken.add('Ctrl+Alt+T')
    const state = hotkeys.setCapture(false)
    expect(state.transcribeRegistered).toBe(false)
    expect(state.listenRegistered).toBe(true)
  })
})

describe('createVoiceHotkeysFileIo', () => {
  it('writes through a temp file and reads the content back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mintbot-hotkeys-'))
    try {
      const filePath = path.join(dir, 'voice-hotkeys.json')
      const io = createVoiceHotkeysFileIo(filePath)
      expect(() => io.read()).toThrow()
      io.write('{"a":1}')
      expect(io.read()).toBe('{"a":1}')
      expect(fs.readdirSync(dir)).toEqual(['voice-hotkeys.json'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
