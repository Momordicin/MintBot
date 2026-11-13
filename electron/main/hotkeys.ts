// electron/main/hotkeys.ts — 全局快捷键：语音输入聆听 / 转写与专注模式 / 角色智能避让的按键动作、<userData>/hotkeys.json 读写（缺失时沿用 voice-hotkeys.json 的语音键）、注册与改键、设置页录入期间的临时注销
// 用法：index.ts 在 app ready 后 createHotkeys(...).start()，will-quit 调 stop()；IPC hotkeys:get / hotkeys:set / hotkeys:capture 调 get / set / setCapture；专注模式 / 角色智能避让经 index.ts 的 patchWindowBehavior 切换
// 对应文件：electron/main/index.ts / electron/main/voiceTray.ts / electron/main/i18n.ts / shared/hotkeys.ts / shared/voiceInputMode.ts / shared/windowBehavior.ts / electron/main/hotkeys.test.ts
import fs from 'fs'
import crypto from 'crypto'
import { DEFAULT_HOTKEYS, HOTKEY_ACTIONS, normalizeHotkey } from '../../shared/hotkeys.js'
import type { HotkeyAction, HotkeySetResult, HotkeysState } from '../../shared/hotkeys.js'
import type { VoiceInputMode } from '../../shared/voiceInputMode.js'
import type { WindowBehaviorConfig } from '../../shared/windowBehavior.js'
import { i18n } from './i18n'
import { parseVoiceTrayState } from './voiceTray'

const NOTIFICATION_TITLE = 'MintBot'

const PRESS_THROTTLE_MS = 1000

type VoiceHotkeyAction = Extract<HotkeyAction, 'listen' | 'transcribe'>

type WindowHotkeyAction = Exclude<HotkeyAction, VoiceHotkeyAction>

const WINDOW_FIELDS: Record<WindowHotkeyAction, 'petClickThrough' | 'petAvoidanceEnabled'> = {
  focus: 'petClickThrough',
  avoidance: 'petAvoidanceEnabled',
}

export type WindowBehaviorPatchResult = { ok: true } | { ok: false; reason: 'rejected' | 'unreachable' }

export function nextModeForHotkey(current: VoiceInputMode, pressed: VoiceHotkeyAction): VoiceInputMode {
  return current === pressed ? 'off' : pressed
}

export interface HotkeysFileIo {
  read: () => string
  write: (content: string) => void
}

export function createHotkeysFileIo(filePath: string): HotkeysFileIo {
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

export interface HotkeysDeps {
  globalShortcut: {
    register: (accelerator: string, callback: () => void) => boolean
    unregister: (accelerator: string) => void
  }
  notify: (title: string, body: string) => void
  io: HotkeysFileIo
  legacyIo: Pick<HotkeysFileIo, 'read'>
  fetchStatus: () => Promise<unknown>
  now: () => number
  switchMode: (mode: VoiceInputMode) => Promise<boolean>
  getWindowBehavior: () => WindowBehaviorConfig
  patchWindowBehavior: (partial: Partial<WindowBehaviorConfig>) => Promise<WindowBehaviorPatchResult>
}

type HotkeyMap = Record<HotkeyAction, string>

function hasDuplicate(map: HotkeyMap): boolean {
  const used = HOTKEY_ACTIONS.map(action => map[action]).filter(key => key !== '')
  return new Set(used).size !== used.length
}

function parseStoredHotkeys(text: string, actions: readonly HotkeyAction[]): HotkeyMap | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const stored = raw as Record<string, unknown>
  const map: HotkeyMap = { ...DEFAULT_HOTKEYS }
  for (const action of actions) {
    const value = stored[action] === '' ? '' : normalizeHotkey(stored[action])
    if (value === null) return null
    map[action] = value
  }
  return hasDuplicate(map) ? null : map
}

function windowNotice(action: WindowHotkeyAction, enabled: boolean): string {
  if (action === 'focus') return enabled ? i18n.t('专注模式：已开启') : i18n.t('专注模式：已关闭')
  return enabled ? i18n.t('角色智能避让：已开启') : i18n.t('角色智能避让：已关闭')
}

function windowFailureNotice(action: WindowHotkeyAction, reason: 'rejected' | 'unreachable'): string {
  if (action === 'focus') {
    return reason === 'rejected' ? i18n.t('专注模式未切换：核心服务拒绝了修改') : i18n.t('专注模式未切换：无法连接核心服务')
  }
  return reason === 'rejected' ? i18n.t('角色智能避让未切换：核心服务拒绝了修改') : i18n.t('角色智能避让未切换：无法连接核心服务')
}

export function createHotkeys(deps: HotkeysDeps) {
  let keys: HotkeyMap = { ...DEFAULT_HOTKEYS }
  const registered: Record<HotkeyAction, boolean> = { listen: false, transcribe: false, focus: false, avoidance: false }
  let capturing = false
  const lastAcceptedPress: Record<'voice' | WindowHotkeyAction, number | null> = { voice: null, focus: null, avoidance: null }

  const readFile = (io: Pick<HotkeysFileIo, 'read'>, name: string): { text: string } | { missing: boolean } => {
    try {
      return { text: io.read() }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true }
      console.error(`[Hotkeys] Failed to read ${name}, using defaults:`, err)
      return { missing: false }
    }
  }

  const load = (): HotkeyMap => {
    const read = readFile(deps.io, 'hotkeys.json')
    if ('text' in read) {
      const parsed = parseStoredHotkeys(read.text, HOTKEY_ACTIONS)
      if (parsed !== null) return parsed
      console.error('[Hotkeys] hotkeys.json is invalid, using defaults')
      return { ...DEFAULT_HOTKEYS }
    }
    if (!read.missing) return { ...DEFAULT_HOTKEYS }
    const legacyRead = readFile(deps.legacyIo, 'voice-hotkeys.json')
    if (!('text' in legacyRead)) return { ...DEFAULT_HOTKEYS }
    const legacy = parseStoredHotkeys(legacyRead.text, ['listen', 'transcribe'])
    if (legacy !== null) return legacy
    console.error('[Hotkeys] voice-hotkeys.json is invalid, using defaults')
    return { ...DEFAULT_HOTKEYS }
  }

  const notifyUnavailable = (): void => deps.notify(NOTIFICATION_TITLE, i18n.t('语音输入当前不可用'))

  const notifyMode = (mode: VoiceInputMode): void => {
    const body =
      mode === 'listen' ? i18n.t('语音输入：聆听') : mode === 'transcribe' ? i18n.t('语音输入：转写') : i18n.t('语音输入：已关闭')
    deps.notify(NOTIFICATION_TITLE, body)
  }

  const tryRegister = (action: HotkeyAction, accelerator: string): boolean => {
    try {
      return deps.globalShortcut.register(accelerator, () => void press(action))
    } catch (err) {
      console.error('[Hotkeys] Failed to register hotkey:', accelerator, err)
      return false
    }
  }

  const pressVoice = async (action: VoiceHotkeyAction): Promise<void> => {
    let current: ReturnType<typeof parseVoiceTrayState>
    try {
      current = parseVoiceTrayState(await deps.fetchStatus())
    } catch (err) {
      console.error('[Hotkeys] Failed to fetch voice status:', err)
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

  const pressWindow = async (action: WindowHotkeyAction): Promise<void> => {
    const field = WINDOW_FIELDS[action]
    const enabled = !deps.getWindowBehavior()[field]
    const result = await deps.patchWindowBehavior({ [field]: enabled })
    deps.notify(NOTIFICATION_TITLE, result.ok ? windowNotice(action, enabled) : windowFailureNotice(action, result.reason))
  }

  const press = async (action: HotkeyAction): Promise<void> => {
    const group = action === 'listen' || action === 'transcribe' ? 'voice' : action
    const at = deps.now()
    const last = lastAcceptedPress[group]
    if (last !== null && at - last < PRESS_THROTTLE_MS) return
    lastAcceptedPress[group] = at
    if (action === 'listen' || action === 'transcribe') await pressVoice(action)
    else await pressWindow(action)
  }

  const serialize = (map: HotkeyMap): string =>
    JSON.stringify({ listen: map.listen, transcribe: map.transcribe, focus: map.focus, avoidance: map.avoidance }, null, 2)

  const state = (): HotkeysState => ({ keys: { ...keys }, registered: { ...registered } })

  return {
    press,
    get: state,
    start(): void {
      keys = load()
      let emptied = false
      for (const action of HOTKEY_ACTIONS) {
        if (keys[action] === '') continue
        registered[action] = tryRegister(action, keys[action])
        if (!registered[action]) {
          console.error('[Hotkeys] Hotkey is taken by another program:', keys[action])
          deps.notify(NOTIFICATION_TITLE, i18n.t('快捷键 {{key}} 已被其他程序占用，无法使用', { key: keys[action] }))
          keys[action] = ''
          emptied = true
        }
      }
      if (!emptied) return
      try {
        deps.io.write(serialize(keys))
      } catch (err) {
        console.error('[Hotkeys] Failed to save hotkeys.json after clearing a taken hotkey:', err)
      }
    },
    stop(): void {
      for (const action of HOTKEY_ACTIONS) {
        if (registered[action] && !capturing) deps.globalShortcut.unregister(keys[action])
      }
    },
    set(input: unknown): HotkeySetResult {
      const provided = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
      const next: HotkeyMap = { ...keys }
      const touched: HotkeyAction[] = []
      for (const action of HOTKEY_ACTIONS) {
        if (provided[action] === undefined) continue
        const normalized = normalizeHotkey(provided[action])
        if (normalized === null) return { ok: false, reason: 'invalid', state: state() }
        next[action] = normalized
        touched.push(action)
      }
      if (hasDuplicate(next)) return { ok: false, reason: 'duplicate', state: state() }

      const changed = touched.filter(action => next[action] !== keys[action] || !registered[action])
      if (changed.length === 0) return { ok: true, state: state() }

      const released = changed.filter(action => registered[action] && !capturing)
      for (const action of released) deps.globalShortcut.unregister(keys[action])
      const acquired: HotkeyAction[] = []
      const rollback = (): void => {
        for (const action of acquired) deps.globalShortcut.unregister(next[action])
        for (const action of released) {
          if (!tryRegister(action, keys[action])) {
            registered[action] = false
            console.error('[Hotkeys] Failed to restore hotkey after a rejected change:', keys[action])
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
    setCapture(active: boolean): HotkeysState {
      if (active && !capturing) {
        for (const action of HOTKEY_ACTIONS) {
          if (registered[action]) deps.globalShortcut.unregister(keys[action])
        }
        capturing = true
      } else if (!active && capturing) {
        capturing = false
        for (const action of HOTKEY_ACTIONS) {
          registered[action] = keys[action] !== '' && tryRegister(action, keys[action])
          if (!registered[action] && keys[action] !== '') console.error('[Hotkeys] Failed to restore hotkey after capture:', keys[action])
        }
      }
      return state()
    },
  }
}
