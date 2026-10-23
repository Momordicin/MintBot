// electron/main/voiceTray.ts — 托盘「语音输入」子菜单：解析 core GET /voice/status 的响应并生成关闭 / 聆听 / 转写单选项
// 用法：index.ts 的 rebuildTrayMenu 调 buildVoiceInputMenu(state, onSelect)；refreshVoiceTray 由 createVoiceTrayRefresher({ fetchStatus, apply }) 生成
// 对应文件：electron/main/index.ts / electron/main/i18n.ts / shared/voiceInputMode.ts / electron/main/voiceTray.test.ts
import type { MenuItemConstructorOptions } from 'electron'
import { isVoiceInputMode } from '../../shared/voiceInputMode.js'
import type { VoiceInputMode } from '../../shared/voiceInputMode.js'
import { i18n } from './i18n'

export interface VoiceTrayState {
  inputMode: VoiceInputMode
  available: boolean
}

export const VOICE_TRAY_UNAVAILABLE: VoiceTrayState = { inputMode: 'off', available: false }

export function parseVoiceTrayState(body: unknown): VoiceTrayState {
  if (typeof body !== 'object' || body === null) return VOICE_TRAY_UNAVAILABLE
  const { installed, install, mode, inputMode } = body as {
    installed?: unknown
    install?: { state?: unknown } | null
    mode?: unknown
    inputMode?: unknown
  }
  return {
    inputMode: isVoiceInputMode(inputMode) ? inputMode : 'off',
    available: installed === true && install?.state !== 'installing' && mode === 'normal',
  }
}

export function createVoiceTrayRefresher(deps: {
  fetchStatus: () => Promise<unknown>
  apply: (state: VoiceTrayState) => void
}): () => Promise<void> {
  let latest = 0
  return async () => {
    const mine = ++latest
    let state = VOICE_TRAY_UNAVAILABLE
    try {
      state = parseVoiceTrayState(await deps.fetchStatus())
    } catch (err) {
      console.error('[Voice] Failed to fetch voice status for the tray:', err)
    }
    if (mine === latest) deps.apply(state)
  }
}

export function buildVoiceInputMenu(
  state: VoiceTrayState,
  onSelect: (mode: VoiceInputMode) => void
): MenuItemConstructorOptions {
  const item = (mode: VoiceInputMode, label: string): MenuItemConstructorOptions => ({
    label,
    type: 'radio',
    checked: state.inputMode === mode,
    enabled: state.available,
    click: () => onSelect(mode),
  })
  return {
    label: i18n.t('语音输入'),
    enabled: state.available,
    submenu: [item('off', i18n.t('关闭')), item('listen', i18n.t('聆听')), item('transcribe', i18n.t('转写'))],
  }
}
