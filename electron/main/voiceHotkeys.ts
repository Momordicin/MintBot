// electron/main/voiceHotkeys.ts — 语音输入全局快捷键：按键到目标模式的映射、<userData>/voice-hotkeys.json 读写、注册与改键、设置页录入期间的临时注销
// 用法：index.ts 在 app ready 后 createVoiceHotkeys(...).start()，will-quit 调 stop()；IPC voice-hotkeys:get / voice-hotkeys:set / voice-hotkeys:capture 调 get / set / setCapture
// 对应文件：electron/main/index.ts / electron/main/voiceTray.ts / electron/main/i18n.ts / shared/voiceHotkeys.ts / shared/voiceInputMode.ts / electron/main/voiceHotkeys.test.ts
import fs from 'fs'
import crypto from 'crypto'
import { DEFAULT_VOICE_HOTKEYS, VOICE_HOTKEY_ACTIONS, normalizeVoiceHotkey } from '../../shared/voiceHotkeys.js'
import type { VoiceHotkeyAction, VoiceHotkeySetResult, VoiceHotkeysState } from '../../shared/voiceHotkeys.js'
import type { VoiceInputMode } from '../../shared/voiceInputMode.js'
import { i18n } from './i18n'
import { parseVoiceTrayState } from './voiceTray'

const NOTIFICATION_TITLE = 'MintBot'

const PRESS_THROTTLE_MS = 1000

export function nextModeForHotkey(current: VoiceInputMode, pressed: VoiceHotkeyAction): VoiceInputMode {
  return current === pressed ? 'off' : pressed
}

export interface VoiceHotkeysFileIo {
  read: () => string
  write: (content: string) => void
}

export function createVoiceHotkeysFileIo(filePath: string): VoiceHotkeysFileIo {
  return {
    read: () => fs.readFileSync(filePath, 'utf-8'),
    write: content => {
      const tempPath = `${filePath}.tmp-${crypto.randomUUID()}`
      try {
        fs.writeFileSync(tempPath, content)
        fs.renameSync(tempPath, filePath)
      } catch (err) {
        try {
          fs.rmSync(tempPath, { force: true })
        } catch {
        }
        throw err
      }
    },
  }
}

export interface VoiceHotkeysDeps {
  globalShortcut: {
    register: (accelerator: string, callback: () => void) => boolean
    unregister: (accelerator: string) => void
  }
  notify: (title: string, body: string) => void
  io: VoiceHotkeysFileIo
  fetchStatus: () => Promise<unknown>
  now: () => number
  switchMode: (mode: VoiceInputMode) => Promise<boolean>
}

type HotkeyMap = Record<VoiceHotkeyAction, string>

function parseStoredHotkeys(text: string): HotkeyMap | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const stored = raw as Record<string, unknown>
  const listen = stored.listen === '' ? '' : normalizeVoiceHotkey(stored.listen)
  const transcribe = stored.transcribe === '' ? '' : normalizeVoiceHotkey(stored.transcribe)
  if (listen === null || transcribe === null || (listen !== '' && listen === transcribe)) return null
  return { listen, transcribe }
}

export function createVoiceHotkeys(deps: VoiceHotkeysDeps) {
  let keys: HotkeyMap = { ...DEFAULT_VOICE_HOTKEYS }
  const registered: Record<VoiceHotkeyAction, boolean> = { listen: false, transcribe: false }
  let capturing = false
  let lastAcceptedPress: number | null = null

  const load = (): HotkeyMap => {
    let text: string
    try {
      text = deps.io.read()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[VoiceHotkeys] Failed to read voice-hotkeys.json, using defaults:', err)
      return { ...DEFAULT_VOICE_HOTKEYS }
    }
    const parsed = parseStoredHotkeys(text)
    if (parsed === null) {
      console.error('[VoiceHotkeys] voice-hotkeys.json is invalid, using defaults')
      return { ...DEFAULT_VOICE_HOTKEYS }
    }
    return parsed
  }

  const notifyUnavailable = (): void => deps.notify(NOTIFICATION_TITLE, i18n.t('语音输入当前不可用'))

  const notifyMode = (mode: VoiceInputMode): void => {
    const body =
      mode === 'listen' ? i18n.t('语音输入：聆听') : mode === 'transcribe' ? i18n.t('语音输入：转写') : i18n.t('语音输入：已关闭')
    deps.notify(NOTIFICATION_TITLE, body)
  }

  const tryRegister = (action: VoiceHotkeyAction, accelerator: string): boolean => {
    try {
      return deps.globalShortcut.register(accelerator, () => void press(action))
    } catch (err) {
      console.error('[VoiceHotkeys] Failed to register hotkey:', accelerator, err)
      return false
    }
  }

  const press = async (action: VoiceHotkeyAction): Promise<void> => {
    const at = deps.now()
    if (lastAcceptedPress !== null && at - lastAcceptedPress < PRESS_THROTTLE_MS) return
    lastAcceptedPress = at
    let current: ReturnType<typeof parseVoiceTrayState>
    try {
      current = parseVoiceTrayState(await deps.fetchStatus())
    } catch (err) {
      console.error('[VoiceHotkeys] Failed to fetch voice status:', err)
      notifyUnavailable()
      return
    }
    if (!current.available) {
      notifyUnavailable()
      return
    }
    const target = nextModeForHotkey(current.inputMode, action)
    if (await deps.switchMode(target)) notifyMode(target)
    else notifyUnavailable()
  }

  const serialize = (map: HotkeyMap): string => JSON.stringify({ listen: map.listen, transcribe: map.transcribe }, null, 2)

  const state = (): VoiceHotkeysState => ({
    listen: keys.listen,
    transcribe: keys.transcribe,
    listenRegistered: registered.listen,
    transcribeRegistered: registered.transcribe,
  })

  return {
    press,
    get: state,
    start(): void {
      keys = load()
      let emptied = false
      for (const action of VOICE_HOTKEY_ACTIONS) {
        if (keys[action] === '') continue
        registered[action] = tryRegister(action, keys[action])
        if (!registered[action]) {
          console.error('[VoiceHotkeys] Hotkey is taken by another program:', keys[action])
          deps.notify(NOTIFICATION_TITLE, i18n.t('快捷键 {{key}} 已被其他程序占用，无法使用', { key: keys[action] }))
          keys[action] = ''
          emptied = true
        }
      }
      if (!emptied) return
      try {
        deps.io.write(serialize(keys))
      } catch (err) {
        console.error('[VoiceHotkeys] Failed to save voice-hotkeys.json after clearing a taken hotkey:', err)
      }
    },
    stop(): void {
      for (const action of VOICE_HOTKEY_ACTIONS) {
        if (registered[action] && !capturing) deps.globalShortcut.unregister(keys[action])
      }
    },
    set(input: unknown): VoiceHotkeySetResult {
      const provided = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
      const next: HotkeyMap = { ...keys }
      const touched: VoiceHotkeyAction[] = []
      for (const action of VOICE_HOTKEY_ACTIONS) {
        if (provided[action] === undefined) continue
        const normalized = normalizeVoiceHotkey(provided[action])
        if (normalized === null) return { ok: false, reason: 'invalid', state: state() }
        next[action] = normalized
        touched.push(action)
      }
      if (next.listen !== '' && next.listen === next.transcribe) return { ok: false, reason: 'duplicate', state: state() }

      const changed = touched.filter(action => next[action] !== keys[action] || !registered[action])
      if (changed.length === 0) return { ok: true, state: state() }

      const released = changed.filter(action => registered[action] && !capturing)
      for (const action of released) deps.globalShortcut.unregister(keys[action])
      const acquired: VoiceHotkeyAction[] = []
      const rollback = (): void => {
        for (const action of acquired) deps.globalShortcut.unregister(next[action])
        for (const action of released) {
          if (!tryRegister(action, keys[action])) {
            registered[action] = false
            console.error('[VoiceHotkeys] Failed to restore hotkey after a rejected change:', keys[action])
          }
        }
      }
      for (const action of changed) {
        if (!tryRegister(action, next[action])) {
          rollback()
          return { ok: false, reason: 'taken', state: state() }
        }
        acquired.push(action)
      }
      try {
        deps.io.write(serialize(next))
      } catch (err) {
        rollback()
        throw err
      }
      if (capturing) for (const action of acquired) deps.globalShortcut.unregister(next[action])
      keys = next
      for (const action of changed) registered[action] = true
      return { ok: true, state: state() }
    },
    setCapture(active: boolean): VoiceHotkeysState {
      if (active && !capturing) {
        for (const action of VOICE_HOTKEY_ACTIONS) {
          if (registered[action]) deps.globalShortcut.unregister(keys[action])
        }
        capturing = true
      } else if (!active && capturing) {
        capturing = false
        for (const action of VOICE_HOTKEY_ACTIONS) {
          registered[action] = keys[action] !== '' && tryRegister(action, keys[action])
          if (!registered[action] && keys[action] !== '') console.error('[VoiceHotkeys] Failed to restore hotkey after capture:', keys[action])
        }
      }
      return state()
    },
  }
}
