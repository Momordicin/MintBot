import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  KEYEVENTF_KEYUP,
  KEYEVENTF_UNICODE,
  VK_CONTROL,
  VK_V,
  buildPasteInputs,
  buildUnicodeInputs,
  createTextOutput,
  type KeyInput,
} from './textOutput'

interface FakeContent {
  text: string
  html: string
  rtf: string
  image: { isEmpty(): boolean }
  extraFormats: string[]
}

const NO_IMAGE = { isEmpty: () => true }

function emptyContent(): FakeContent {
  return { text: '', html: '', rtf: '', image: NO_IMAGE, extraFormats: [] }
}

function setup(exeName: string | null, initial: Partial<FakeContent> = { text: 'previous' }, platform: NodeJS.Platform = 'win32') {
  const sent: KeyInput[][] = []
  let content: FakeContent = { ...emptyContent(), ...initial }
  const output = createTextOutput({
    sendInput: inputs => {
      sent.push(inputs)
    },
    getForegroundExeName: () => exeName,
    clipboard: {
      availableFormats: () => [
        ...(content.text !== '' ? ['text/plain'] : []),
        ...(content.html !== '' ? ['text/html'] : []),
        ...(content.rtf !== '' ? ['text/rtf'] : []),
        ...(content.image.isEmpty() ? [] : ['image/png']),
        ...content.extraFormats,
      ],
      readText: () => content.text,
      readHTML: () => content.html,
      readRTF: () => content.rtf,
      readImage: () => content.image,
      writeText: text => {
        content = { ...emptyContent(), text }
      },
      write: data => {
        content = { ...emptyContent(), text: data.text ?? '', html: data.html ?? '', rtf: data.rtf ?? '', image: data.image ?? NO_IMAGE }
      },
      clear: () => {
        content = emptyContent()
      },
    },
    platform,
  })
  return {
    output,
    sent,
    clipboard: () => content,
    userCopies: (next: Partial<FakeContent>) => {
      content = { ...emptyContent(), ...next }
    },
  }
}

describe('buildUnicodeInputs', () => {
  it('sends a key down and a key up per UTF-16 code unit, surrogate pairs as two units', () => {
    const inputs = buildUnicodeInputs('a😀')
    const high = '😀'.charCodeAt(0)
    const low = '😀'.charCodeAt(1)
    expect(inputs).toEqual([
      { vk: 0, scan: 0x61, flags: KEYEVENTF_UNICODE },
      { vk: 0, scan: 0x61, flags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP },
      { vk: 0, scan: high, flags: KEYEVENTF_UNICODE },
      { vk: 0, scan: high, flags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP },
      { vk: 0, scan: low, flags: KEYEVENTF_UNICODE },
      { vk: 0, scan: low, flags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP },
    ])
  })
})

describe('buildPasteInputs', () => {
  it('presses Ctrl+V and releases in reverse order', () => {
    expect(buildPasteInputs()).toEqual([
      { vk: VK_CONTROL, scan: 0, flags: 0 },
      { vk: VK_V, scan: 0, flags: 0 },
      { vk: VK_V, scan: 0, flags: KEYEVENTF_KEYUP },
      { vk: VK_CONTROL, scan: 0, flags: KEYEVENTF_KEYUP },
    ])
  })
})

describe('createTextOutput', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('types into an ordinary application without touching the clipboard', () => {
    const { output, sent, clipboard } = setup('notepad.exe')
    output.typeText('你好😀')
    expect(sent).toEqual([buildUnicodeInputs('你好😀')])
    expect(clipboard()).toEqual({ ...emptyContent(), text: 'previous' })
  })

  it('pastes into WeiXin.exe case-insensitively and restores the previous clipboard text after 100 ms', () => {
    const { output, sent, clipboard } = setup('WEIXIN.EXE', { text: 'old text' })
    output.typeText('hello')
    expect(sent).toEqual([buildPasteInputs()])
    expect(clipboard().text).toBe('hello')
    vi.advanceTimersByTime(99)
    expect(clipboard().text).toBe('hello')
    vi.advanceTimersByTime(1)
    expect(clipboard()).toEqual({ ...emptyContent(), text: 'old text' })
  })

  it('restores an image that was on the clipboard', () => {
    const image = { isEmpty: () => false }
    const { output, clipboard } = setup('WeiXin.exe', { image })
    output.typeText('hello')
    expect(clipboard().image).toBe(NO_IMAGE)
    vi.advanceTimersByTime(100)
    expect(clipboard().image).toBe(image)
    expect(clipboard().text).toBe('')
  })

  it('restores text, html and rtf together', () => {
    const { output, clipboard } = setup('Telegram.exe', { text: 'a', html: '<b>a</b>', rtf: '{\\rtf1 a}' })
    output.typeText('hello')
    vi.advanceTimersByTime(100)
    expect(clipboard()).toEqual({ ...emptyContent(), text: 'a', html: '<b>a</b>', rtf: '{\\rtf1 a}' })
  })

  it('clears the clipboard instead of restoring when it held a format that cannot be restored', () => {
    const { output, clipboard } = setup('WeiXin.exe', { text: 'a.txt', extraFormats: ['text/uri-list'] })
    output.typeText('hello')
    expect(clipboard().text).toBe('hello')
    vi.advanceTimersByTime(100)
    expect(clipboard()).toEqual(emptyContent())
  })

  it('leaves the clipboard alone when the user copied something during the 100 ms window', () => {
    const { output, clipboard, userCopies } = setup('WeiXin.exe', { text: 'old text', extraFormats: ['text/uri-list'] })
    output.typeText('hello')
    vi.advanceTimersByTime(50)
    userCopies({ text: 'user copy' })
    vi.advanceTimersByTime(100)
    expect(clipboard()).toEqual({ ...emptyContent(), text: 'user copy' })
  })

  it('restores an empty clipboard to empty', () => {
    const { output, clipboard } = setup('WeiXin.exe', {})
    output.typeText('hello')
    vi.advanceTimersByTime(100)
    expect(clipboard()).toEqual(emptyContent())
  })

  it('pastes into Telegram.exe', () => {
    const { output, sent } = setup('Telegram.exe')
    output.typeText('hi')
    expect(sent).toEqual([buildPasteInputs()])
  })

  it('keeps the original clipboard content when a second paste arrives before the restore', () => {
    const { output, clipboard } = setup('WeiXin.exe', { text: 'original' })
    output.typeText('one')
    vi.advanceTimersByTime(50)
    output.typeText('two')
    expect(clipboard().text).toBe('two')
    vi.advanceTimersByTime(100)
    expect(clipboard()).toEqual({ ...emptyContent(), text: 'original' })
  })

  it('keeps the unrestorable verdict of the first paste for a second paste', () => {
    const { output, clipboard } = setup('WeiXin.exe', { text: 'a.txt', extraFormats: ['text/uri-list'] })
    output.typeText('one')
    vi.advanceTimersByTime(50)
    output.typeText('two')
    vi.advanceTimersByTime(100)
    expect(clipboard()).toEqual(emptyContent())
  })

  it('types when the foreground executable is unknown', () => {
    const { output, sent } = setup(null)
    output.typeText('x')
    expect(sent).toEqual([buildUnicodeInputs('x')])
  })

  it('does nothing on a non-win32 platform or for empty text', () => {
    const linux = setup('notepad.exe', { text: 'previous' }, 'linux')
    linux.output.typeText('x')
    expect(linux.sent).toEqual([])
    const win = setup('notepad.exe')
    win.output.typeText('')
    expect(win.sent).toEqual([])
  })
})
