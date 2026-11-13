import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHotkeys, createHotkeysFileIo, nextModeForHotkey } from './hotkeys'
import type { WindowBehaviorPatchResult } from './hotkeys'
import { DEFAULT_HOTKEYS } from '../../shared/hotkeys.js'
import type { VoiceInputMode } from '../../shared/voiceInputMode.js'
import type { WindowBehaviorConfig } from '../../shared/windowBehavior.js'

const AVAILABLE = { installed: true, install: { state: 'idle' }, mode: 'normal' }

const DEFAULT_KEYS = ['Ctrl+Alt+L', 'Ctrl+Alt+T', 'F7', 'F8', 'F9']

function setup(options: {
  file?: string | null
  legacy?: string | null
  taken?: string[]
  status?: unknown
  switchResult?: boolean
  windowBehavior?: Partial<WindowBehaviorConfig>
  patchResult?: WindowBehaviorPatchResult
} = {}) {
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
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' })
  let file = options.file ?? null
  const io = {
    read: vi.fn(() => {
      if (file === null) throw missing()
      return file
    }),
    write: vi.fn((content: string) => {
      file = content
    }),
  }
  const legacyIo = {
    read: vi.fn(() => {
      if (options.legacy == null) throw missing()
      return options.legacy
    }),
  }
  const fetchStatus = vi.fn(async () => options.status ?? { ...AVAILABLE, inputMode: 'off' })
  const switchMode = vi.fn(async (_mode: VoiceInputMode) => options.switchResult ?? true)
  const getWindowBehavior = vi.fn(() => ({ petClickThrough: false, petAvoidanceEnabled: true, ...options.windowBehavior }) as WindowBehaviorConfig)
  const patchWindowBehavior = vi.fn(async (_partial: Partial<WindowBehaviorConfig>) => options.patchResult ?? ({ ok: true } as WindowBehaviorPatchResult))
  const moveToNextDisplay = vi.fn()
  const clock = { value: 10_000 }
  const hotkeys = createHotkeys({
    globalShortcut,
    notify,
    io,
    legacyIo,
    fetchStatus,
    now: () => clock.value,
    switchMode,
    getWindowBehavior,
    patchWindowBehavior,
    moveToNextDisplay,
  })
  return { hotkeys, active, globalShortcut, notify, io, legacyIo, fetchStatus, switchMode, patchWindowBehavior, moveToNextDisplay, taken, clock, getFile: () => file }
}

const keysOf = (active: Map<string, () => void>) => [...active.keys()].sort()

const ALL_REGISTERED = { listen: true, transcribe: true, focus: true, avoidance: true, nextDisplay: true }

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

describe('voice key press', () => {
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

describe('window key press', () => {
  it.each([
    ['focus', { petClickThrough: false }, { petClickThrough: true }, '专注模式：已开启'],
    ['focus', { petClickThrough: true }, { petClickThrough: false }, '专注模式：已关闭'],
    ['avoidance', { petAvoidanceEnabled: false }, { petAvoidanceEnabled: true }, '角色智能避让：已开启'],
    ['avoidance', { petAvoidanceEnabled: true }, { petAvoidanceEnabled: false }, '角色智能避让：已关闭'],
  ] as const)('%s patches the negated value %o and notifies', async (action, current, patch, message) => {
    const { hotkeys, patchWindowBehavior, notify, fetchStatus } = setup({ windowBehavior: current })
    await hotkeys.press(action)
    expect(patchWindowBehavior).toHaveBeenCalledTimes(1)
    expect(patchWindowBehavior).toHaveBeenCalledWith(patch)
    expect(fetchStatus).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('MintBot', message)
  })

  it.each([
    ['focus', 'rejected', '专注模式未切换：核心服务拒绝了修改'],
    ['focus', 'unreachable', '专注模式未切换：无法连接核心服务'],
    ['avoidance', 'rejected', '角色智能避让未切换：核心服务拒绝了修改'],
    ['avoidance', 'unreachable', '角色智能避让未切换：无法连接核心服务'],
  ] as const)('%s notifies the failure reason %s', async (action, reason, message) => {
    const { hotkeys, notify } = setup({ patchResult: { ok: false, reason } })
    await hotkeys.press(action)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('MintBot', message)
  })
})

describe('screen key press', () => {
  it('moves the character to the next screen without a status request, patch or notification', async () => {
    const { hotkeys, active, moveToNextDisplay, fetchStatus, patchWindowBehavior, notify } = setup()
    hotkeys.start()
    active.get('F7')?.()
    await vi.waitFor(() => expect(moveToNextDisplay).toHaveBeenCalledTimes(1))
    expect(fetchStatus).not.toHaveBeenCalled()
    expect(patchWindowBehavior).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('startup registration', () => {
  it('registers the default hotkeys when both files are missing and does not create one', () => {
    const { hotkeys, active, io, notify } = setup()
    hotkeys.start()
    expect(keysOf(active)).toEqual(DEFAULT_KEYS)
    expect(io.write).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(hotkeys.get()).toEqual({
      keys: { listen: 'Ctrl+Alt+L', transcribe: 'Ctrl+Alt+T', focus: 'F9', avoidance: 'F8', nextDisplay: 'F7' },
      registered: ALL_REGISTERED,
    })
  })

  it('uses the stored hotkeys and ignores voice-hotkeys.json', () => {
    const { hotkeys, active, legacyIo } = setup({
      file: JSON.stringify({ listen: 'Ctrl+Shift+F1', transcribe: 'Alt+F2', focus: 'F10', avoidance: '' }),
      legacy: JSON.stringify({ listen: 'Ctrl+Shift+K', transcribe: 'Ctrl+Shift+J' }),
    })
    hotkeys.start()
    expect(keysOf(active)).toEqual(['Alt+F2', 'Ctrl+Shift+F1', 'F10', 'F7'])
    expect(legacyIo.read).not.toHaveBeenCalled()
  })

  it.each([
    ['fills the default when it is free', { listen: 'Ctrl+Shift+F1', transcribe: 'Alt+F2', focus: 'F10', avoidance: '' }, 'F7'],
    ['leaves it empty when another key already uses the default', { listen: 'Ctrl+Shift+F1', transcribe: 'Alt+F2', focus: 'F10', avoidance: 'F7' }, ''],
  ])('a hotkeys.json without the screen key %s and keeps the other keys', (_name, stored, nextDisplay) => {
    const { hotkeys, io } = setup({ file: JSON.stringify(stored) })
    hotkeys.start()
    expect(hotkeys.get().keys).toEqual({ ...stored, nextDisplay })
    expect(io.write).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('takes the voice keys from voice-hotkeys.json when hotkeys.json is missing, without writing either file', () => {
    const legacy = JSON.stringify({ listen: 'Ctrl+Shift+K', transcribe: '' })
    const { hotkeys, io } = setup({ legacy })
    hotkeys.start()
    expect(hotkeys.get().keys).toEqual({ listen: 'Ctrl+Shift+K', transcribe: '', focus: 'F9', avoidance: 'F8', nextDisplay: 'F7' })
    expect(io.write).not.toHaveBeenCalled()
  })

  it.each([
    ['unparsable JSON', '{nope'],
    ['a letter key without a modifier', JSON.stringify({ listen: 'L', transcribe: 'Ctrl+Alt+T' })],
    ['a missing field', JSON.stringify({ listen: 'Ctrl+Alt+L' })],
    ['a key equal to a window default', JSON.stringify({ listen: 'F9', transcribe: 'Ctrl+Alt+T' })],
  ])('falls back to the defaults for an invalid voice-hotkeys.json with %s', (_name, legacy) => {
    const { hotkeys, active } = setup({ legacy })
    hotkeys.start()
    expect(keysOf(active)).toEqual(DEFAULT_KEYS)
    expect(errorSpy).toHaveBeenCalled()
  })

  it.each([
    ['unparsable JSON', '{nope'],
    ['a letter key without a modifier', JSON.stringify({ listen: 'L', transcribe: 'Ctrl+Alt+T', focus: 'F9', avoidance: 'F8' })],
    ['a missing field', JSON.stringify({ listen: 'Ctrl+Alt+L', transcribe: 'Ctrl+Alt+T', focus: 'F9' })],
    ['duplicates across voice and window keys', JSON.stringify({ listen: 'F8', transcribe: 'Ctrl+Alt+T', focus: 'F9', avoidance: 'F8' })],
  ])('falls back to the defaults for %s without overwriting the file', (_name, content) => {
    const { hotkeys, active, io, legacyIo, getFile } = setup({ file: content, legacy: JSON.stringify({ listen: 'Ctrl+Shift+K', transcribe: 'Ctrl+Shift+J' }) })
    hotkeys.start()
    expect(keysOf(active)).toEqual(DEFAULT_KEYS)
    expect(io.write).not.toHaveBeenCalled()
    expect(legacyIo.read).not.toHaveBeenCalled()
    expect(getFile()).toBe(content)
    expect(errorSpy).toHaveBeenCalled()
  })

  it('uses the defaults without reading voice-hotkeys.json when hotkeys.json exists but cannot be read', () => {
    const { hotkeys, io, legacyIo } = setup({ legacy: JSON.stringify({ listen: 'Ctrl+Shift+K', transcribe: 'Ctrl+Shift+J' }) })
    io.read.mockImplementation(() => {
      throw Object.assign(new Error('locked'), { code: 'EPERM' })
    })
    hotkeys.start()
    expect(hotkeys.get().keys).toEqual(DEFAULT_HOTKEYS)
    expect(legacyIo.read).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalled()
  })

  it('notifies once for a key that cannot be registered, logs an error and empties and saves it', () => {
    const { hotkeys, notify, active, getFile } = setup({ taken: ['F9'] })
    hotkeys.start()
    expect(hotkeys.get().keys.focus).toBe('')
    expect(JSON.parse(getFile() as string)).toEqual({ listen: 'Ctrl+Alt+L', transcribe: 'Ctrl+Alt+T', focus: '', avoidance: 'F8', nextDisplay: 'F7' })
    expect(keysOf(active)).toEqual(['Ctrl+Alt+L', 'Ctrl+Alt+T', 'F7', 'F8'])
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('MintBot', '快捷键 F9 已被其他程序占用，无法使用')
    expect(errorSpy).toHaveBeenCalled()
    expect(hotkeys.get().registered).toEqual({ ...ALL_REGISTERED, focus: false })
  })

  it('keeps stored empty keys empty, never registers them and does not notify', () => {
    const { hotkeys, active, io, notify } = setup({ file: JSON.stringify({ listen: '', transcribe: 'Alt+F2', focus: '', avoidance: '', nextDisplay: '' }) })
    hotkeys.start()
    expect(keysOf(active)).toEqual(['Alt+F2'])
    expect(hotkeys.get()).toEqual({
      keys: { listen: '', transcribe: 'Alt+F2', focus: '', avoidance: '', nextDisplay: '' },
      registered: { listen: false, transcribe: true, focus: false, avoidance: false, nextDisplay: false },
    })
    expect(io.write).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('keeps the key empty when saving the emptied key fails', () => {
    const { hotkeys, io } = setup({ taken: ['Ctrl+Alt+T'] })
    io.write.mockImplementationOnce(() => {
      throw new Error('disk')
    })
    hotkeys.start()
    expect(hotkeys.get().keys.transcribe).toBe('')
  })

  it('stop unregisters every hotkey', () => {
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
    expect(result.state.keys.listen).toBe('Ctrl+Shift+K')
    expect(keysOf(active)).toEqual(['Ctrl+Alt+T', 'Ctrl+Shift+K', 'F7', 'F8', 'F9'])
    expect(JSON.parse(getFile() as string)).toEqual({ listen: 'Ctrl+Shift+K', transcribe: 'Ctrl+Alt+T', focus: 'F9', avoidance: 'F8', nextDisplay: 'F7' })
  })

  it.each([
    ['a letter without a modifier', { listen: 'K' }],
    ['modifiers only', { listen: 'Ctrl+Alt' }],
    ['a non-string', { listen: 5 }],
  ])('rejects %s as invalid and keeps the old key working', (_name, input) => {
    const { hotkeys, active, io } = setup()
    hotkeys.start()
    expect(hotkeys.set(input)).toMatchObject({ ok: false, reason: 'invalid' })
    expect(active.has('Ctrl+Alt+L')).toBe(true)
    expect(io.write).not.toHaveBeenCalled()
  })

  it.each([
    ['another voice key', { listen: 'Alt+Ctrl+T' }],
    ['a window key from a voice row', { transcribe: 'F9' }],
    ['a voice key from a window row', { avoidance: 'Ctrl+Alt+L' }],
    ['the other window key', { focus: 'F8' }],
    ['the screen key from a window row', { focus: 'F7' }],
    ['a voice key from the screen row', { nextDisplay: 'Ctrl+Alt+L' }],
  ])('rejects the same key as %s and keeps the old keys working', (_name, input) => {
    const { hotkeys, active, io } = setup()
    hotkeys.start()
    expect(hotkeys.set(input)).toMatchObject({ ok: false, reason: 'duplicate' })
    expect(keysOf(active)).toEqual(DEFAULT_KEYS)
    expect(io.write).not.toHaveBeenCalled()
  })

  it('reports taken when registration fails and keeps the old key working', () => {
    const { hotkeys, active, io } = setup({ taken: ['Ctrl+Shift+K'] })
    hotkeys.start()
    const result = hotkeys.set({ listen: 'Ctrl+Shift+K' })
    expect(result).toMatchObject({ ok: false, reason: 'taken' })
    expect(result.state.keys.listen).toBe('Ctrl+Alt+L')
    expect(active.has('Ctrl+Alt+L')).toBe(true)
    expect(io.write).not.toHaveBeenCalled()
  })

  it('swaps two keys in one call', () => {
    const { hotkeys, active } = setup()
    hotkeys.start()
    const result = hotkeys.set({ focus: 'F8', avoidance: 'F9' })
    expect(result.ok).toBe(true)
    expect(result.state.keys).toMatchObject({ focus: 'F8', avoidance: 'F9' })
    expect(keysOf(active)).toEqual(DEFAULT_KEYS)
  })

  it('restores the old keys when a later key in the same call fails', () => {
    const { hotkeys, active } = setup({ taken: ['Ctrl+Shift+K'] })
    hotkeys.start()
    const result = hotkeys.set({ listen: 'Ctrl+Shift+J', transcribe: 'Ctrl+Shift+K' })
    expect(result).toMatchObject({ ok: false, reason: 'taken' })
    expect(keysOf(active)).toEqual(DEFAULT_KEYS)
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
    expect(hotkeys.get().keys.listen).toBe('Ctrl+Alt+L')
  })

  it('retries registering an unchanged key that was taken at startup', () => {
    const { hotkeys, taken, active } = setup({ taken: ['Ctrl+Alt+T'] })
    hotkeys.start()
    taken.clear()
    const result = hotkeys.set({ transcribe: 'Ctrl+Alt+T' })
    expect(result.ok).toBe(true)
    expect(result.state.registered.transcribe).toBe(true)
    expect(active.has('Ctrl+Alt+T')).toBe(true)
  })

  it('reports taken when a restored default is still taken and stays empty', () => {
    const { hotkeys } = setup({ file: JSON.stringify({ listen: '', transcribe: 'Ctrl+Alt+T', focus: 'F9', avoidance: 'F8' }), taken: ['Ctrl+Alt+L'] })
    hotkeys.start()
    const result = hotkeys.set({ listen: 'Ctrl+Alt+L' })
    expect(result).toMatchObject({ ok: false, reason: 'taken' })
    expect(result.state.keys.listen).toBe('')
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

  it('shares the window between the two voice keys', async () => {
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

  it('throttles each window key on its own and apart from the voice keys', async () => {
    const { hotkeys, fetchStatus, patchWindowBehavior, clock } = setup()
    await hotkeys.press('listen')
    await hotkeys.press('focus')
    await hotkeys.press('avoidance')
    clock.value += 500
    await hotkeys.press('focus')
    await hotkeys.press('avoidance')
    clock.value += 500
    await hotkeys.press('focus')
    expect(fetchStatus).toHaveBeenCalledTimes(1)
    expect(patchWindowBehavior.mock.calls.map(call => Object.keys(call[0])[0])).toEqual(['petClickThrough', 'petAvoidanceEnabled', 'petClickThrough'])
  })

  it('throttles the screen key on its own', async () => {
    const { hotkeys, moveToNextDisplay, patchWindowBehavior, clock } = setup()
    await hotkeys.press('nextDisplay')
    await hotkeys.press('focus')
    clock.value += 999
    await hotkeys.press('nextDisplay')
    clock.value += 1
    await hotkeys.press('nextDisplay')
    expect(moveToNextDisplay).toHaveBeenCalledTimes(2)
    expect(patchWindowBehavior).toHaveBeenCalledTimes(1)
  })
})

describe('capture', () => {
  it('unregisters every hotkey on start and registers them again on end', () => {
    const { hotkeys, active } = setup()
    hotkeys.start()
    hotkeys.setCapture(true)
    expect(active.size).toBe(0)
    expect(hotkeys.get().registered).toEqual(ALL_REGISTERED)
    hotkeys.setCapture(false)
    expect(keysOf(active)).toEqual(DEFAULT_KEYS)
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
    const result = hotkeys.set({ focus: 'F10' })
    expect(result.ok).toBe(true)
    expect(active.size).toBe(0)
    hotkeys.setCapture(false)
    expect(keysOf(active)).toEqual(['Ctrl+Alt+L', 'Ctrl+Alt+T', 'F10', 'F7', 'F8'])
  })

  it('marks a key unregistered when it cannot be restored after capture', () => {
    const { hotkeys, taken } = setup()
    hotkeys.start()
    hotkeys.setCapture(true)
    taken.add('F8')
    const state = hotkeys.setCapture(false)
    expect(state.registered).toEqual({ ...ALL_REGISTERED, avoidance: false })
  })
})

describe('createHotkeysFileIo', () => {
  it('writes through a temp file and reads the content back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mintbot-hotkeys-'))
    try {
      const filePath = path.join(dir, 'hotkeys.json')
      const io = createHotkeysFileIo(filePath)
      expect(() => io.read()).toThrow()
      io.write('{"a":1}')
      expect(io.read()).toBe('{"a":1}')
      expect(fs.readdirSync(dir)).toEqual(['hotkeys.json'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
