// electron/main/textOutput.ts — 转写模式的文字输出：把识别文字输入当前前台窗口
// 用法：index.ts 里 createTextOutput({ sendInput, getForegroundExeName, clipboard }) 一次，voice-type 事件处理里调返回的 typeText(text)
// 对应文件：electron/main/sendInput.ts / electron/main/activeWindowMonitor.ts / electron/main/coreEventsConsumer.ts / electron/main/textOutput.test.ts
export interface KeyInput {
  vk: number
  scan: number
  flags: number
}

export interface TextOutputDeps {
  sendInput: (inputs: KeyInput[]) => void
  getForegroundExeName: () => string | null
  clipboard: ClipboardAccess
  platform?: NodeJS.Platform
}

export interface ClipboardImage {
  isEmpty(): boolean
}

export interface ClipboardAccess {
  availableFormats(): string[]
  readText(): string
  readHTML(): string
  readRTF(): string
  readImage(): ClipboardImage
  writeText(text: string): void
  write(data: { text?: string; html?: string; rtf?: string; image?: ClipboardImage }): void
  clear(): void
}

type ClipboardSnapshot =
  | { restorable: false }
  | { restorable: true; text: string; html: string; rtf: string; image: ClipboardImage | null }

const RESTORABLE_FORMATS = new Set(['text/plain', 'text/html', 'text/rtf'])

export const KEYEVENTF_KEYUP = 0x0002
export const KEYEVENTF_UNICODE = 0x0004
export const VK_CONTROL = 0x11
export const VK_V = 0x56

const PASTE_APPS = new Set(['weixin.exe', 'telegram.exe'])
const CLIPBOARD_RESTORE_DELAY_MS = 100

export function buildUnicodeInputs(text: string): KeyInput[] {
  const inputs: KeyInput[] = []
  for (let i = 0; i < text.length; i++) {
    const scan = text.charCodeAt(i)
    inputs.push({ vk: 0, scan, flags: KEYEVENTF_UNICODE })
    inputs.push({ vk: 0, scan, flags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP })
  }
  return inputs
}

export function buildPasteInputs(): KeyInput[] {
  return [
    { vk: VK_CONTROL, scan: 0, flags: 0 },
    { vk: VK_V, scan: 0, flags: 0 },
    { vk: VK_V, scan: 0, flags: KEYEVENTF_KEYUP },
    { vk: VK_CONTROL, scan: 0, flags: KEYEVENTF_KEYUP },
  ]
}

export function createTextOutput(deps: TextOutputDeps): { typeText: (text: string) => void } {
  const { clipboard } = deps
  let pendingRestore: { previous: ClipboardSnapshot; timer: ReturnType<typeof setTimeout> } | null = null

  function snapshotClipboard(): ClipboardSnapshot {
    const formats = clipboard.availableFormats()
    if (!formats.every(format => RESTORABLE_FORMATS.has(format) || format.startsWith('image/'))) return { restorable: false }
    const image = clipboard.readImage()
    return {
      restorable: true,
      text: clipboard.readText(),
      html: clipboard.readHTML(),
      rtf: clipboard.readRTF(),
      image: image.isEmpty() ? null : image,
    }
  }

  function restoreClipboard(snapshot: ClipboardSnapshot): void {
    clipboard.clear()
    if (!snapshot.restorable) return
    const { text, html, rtf, image } = snapshot
    clipboard.write({
      ...(text !== '' && { text }),
      ...(html !== '' && { html }),
      ...(rtf !== '' && { rtf }),
      ...(image !== null && { image }),
    })
  }

  function paste(text: string): void {
    const previous = pendingRestore ? pendingRestore.previous : snapshotClipboard()
    if (pendingRestore) clearTimeout(pendingRestore.timer)
    clipboard.writeText(text)
    deps.sendInput(buildPasteInputs())
    const timer = setTimeout(() => {
      pendingRestore = null
      if (clipboard.readText() === text) restoreClipboard(previous)
    }, CLIPBOARD_RESTORE_DELAY_MS)
    pendingRestore = { previous, timer }
  }

  function typeText(text: string): void {
    if ((deps.platform ?? process.platform) !== 'win32' || text === '') return
    const exeName = deps.getForegroundExeName()
    if (exeName !== null && PASTE_APPS.has(exeName.toLowerCase())) paste(text)
    else deps.sendInput(buildUnicodeInputs(text))
  }

  return { typeText }
}
