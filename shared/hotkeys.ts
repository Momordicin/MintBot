// shared/hotkeys.ts — 全局快捷键（语音输入聆听 / 转写、专注模式、角色智能避让、角色换屏）的取值、默认值、校验规范化，以及键盘事件到 Electron accelerator 的转换
// 用法：Electron 主进程 hotkeys.ts 用 normalizeHotkey 校验并用类型声明 IPC 载荷；设置窗口 HotkeysSection.tsx 用 acceleratorFromKeyEvent / resolveHotkeyCapture / DEFAULT_HOTKEYS；通道 hotkeys:get / hotkeys:set / hotkeys:capture
// 对应文件：electron/main/hotkeys.ts / src/settings/HotkeysSection.tsx / src/settings/VoicePanel.tsx / src/settings/WindowBehaviorPanel.tsx / src/electron-api.d.ts / electron/preload/index.ts / shared/hotkeys.test.ts
export const HOTKEY_ACTIONS = ['listen', 'transcribe', 'focus', 'avoidance', 'nextDisplay'] as const

export type HotkeyAction = typeof HOTKEY_ACTIONS[number]

export const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  listen: 'Ctrl+Alt+L',
  transcribe: 'Ctrl+Alt+T',
  focus: 'F9',
  avoidance: 'F8',
  nextDisplay: 'F7',
}

export interface HotkeysState {
  keys: Record<HotkeyAction, string>
  registered: Record<HotkeyAction, boolean>
}

export type HotkeyFailure = 'invalid' | 'duplicate' | 'taken'

export type HotkeySetResult =
  | { ok: true; state: HotkeysState }
  | { ok: false; reason: HotkeyFailure; state: HotkeysState }

const MODIFIERS = ['Ctrl', 'Alt', 'Shift'] as const

const FUNCTION_KEY_PATTERN = /^F(?:[1-9]|1[0-9]|2[0-4])$/

const KEY_PATTERN = /^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert|Delete|Backspace|Tab|Return)$/

const NAMED_KEYS: Record<string, string> = {
  Space: 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  Delete: 'Delete',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Enter: 'Return',
}

export function normalizeHotkey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const parts = value.split('+')
  const key = parts.pop() as string
  if (!KEY_PATTERN.test(key) || (parts.length === 0 && !FUNCTION_KEY_PATTERN.test(key))) return null
  const mods = new Set<string>()
  for (const part of parts) {
    if (!(MODIFIERS as readonly string[]).includes(part) || mods.has(part)) return null
    mods.add(part)
  }
  return [...MODIFIERS.filter(mod => mods.has(mod)), key].join('+')
}

export interface HotkeyKeyEventLike {
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

export function acceleratorFromKeyEvent(event: HotkeyKeyEventLike): string | null {
  if (event.metaKey) return null
  const letter = /^Key([A-Z])$/.exec(event.code)
  const digit = /^Digit([0-9])$/.exec(event.code)
  const key = letter?.[1] ?? digit?.[1] ?? (/^F\d+$/.test(event.code) ? event.code : NAMED_KEYS[event.code])
  if (key === undefined || !KEY_PATTERN.test(key)) return null
  const mods = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift'].filter(Boolean)
  return [...mods, key].join('+')
}

export interface HotkeyCaptureEvent extends HotkeyKeyEventLike {
  type: 'keydown' | 'keyup'
}

export type HotkeyCaptureResult =
  | { status: 'pending' }
  | { status: 'cancelled' }
  | { status: 'done'; accelerator: string | null }

export function resolveHotkeyCapture(events: readonly HotkeyCaptureEvent[]): HotkeyCaptureResult {
  const held = new Set<string>()
  let accelerator: string | null = null
  let pressed = false
  for (const event of events) {
    if (event.type === 'keydown') {
      if (event.code === 'Escape') return { status: 'cancelled' }
      pressed = true
      held.add(event.code)
      accelerator = acceleratorFromKeyEvent(event) ?? accelerator
    } else {
      held.delete(event.code)
      if (pressed && held.size === 0) return { status: 'done', accelerator }
    }
  }
  return { status: 'pending' }
}
