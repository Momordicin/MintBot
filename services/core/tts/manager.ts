// services/core/tts/manager.ts — 持有语音合成组件（GPT-SoVITS）的管理器：创建、状态变化广播与失败日志、按开关与当前角色启动/停止服务和切换语音模型、检查新版本、退出时释放
// 用法：core/index.ts 的 start() 调 initTts()，SIGINT/SIGTERM 时调 disposeTts()；session/index.ts 的 loadSession 调 applyCharacterVoice()；tts/routes.ts 调 getTtsManager()、TTS_DEFAULT_ROOT、characterVoiceStatus()、applyTtsEnabled()、applyCharacterVoice()；tts/narration.ts 调 getTtsManager()、characterVoiceStatus()；关闭语音合成或服务停止、失败时调 tts/narration.ts 的 stopNarration()；voice/routes.ts 的 GET /voice/update-check 调 checkTtsUpdate()；状态变化时 broadcastEvent('tts-status-changed')
// 对应文件：services/core/tts/routes.ts / services/core/tts/narration.ts / services/core/session/index.ts / services/core/characters/manifest.ts / services/core/config/index.ts / services/core/voice/install.ts / services/core/voice/routes.ts / services/core/events/broadcast.ts / services/core/index.ts / services/core/tts/routes.test.ts
import fs from 'fs'
import path from 'path'
import {
  createTtsManager,
  type TtsInstallStatus,
  type TtsManager,
  type TtsModel,
  type TtsServiceStatus,
} from '@mintbot/voice-agent-client'
import { CHARACTERS_ROOT, type CharacterManifest } from '../characters/manifest.js'
import { getTtsEnabled, setTtsEnabled } from '../config/index.js'
import { broadcastEvent } from '../events/broadcast.js'
import { REMOTE_MANIFEST_TIMEOUT_MS, VOICE_INSTALL_ROOT, resolveManifestUrl } from '../voice/install.js'
import { stopNarration } from './narration.js'

export const TTS_DEFAULT_ROOT = path.resolve(process.cwd(), 'data', 'tts')

const UPDATE_CHECK_CACHE_MS = 10 * 60 * 1000

export interface TtsCharacter {
  characterId: string
  manifest: CharacterManifest | null
}

export interface CharacterVoiceStatus {
  voice: 'unconfigured' | 'missing' | 'ok'
  missing: string[]
  model: TtsModel | null
}

let manager: TtsManager | null = null
let lastInstall: TtsInstallStatus = { state: 'idle' }
let lastService: TtsServiceStatus = { state: 'stopped', model: null, modelState: 'none' }
let updateCheckedAt: number | null = null

function logInstallFailure(install: TtsInstallStatus): void {
  if (install.state === 'failed' && JSON.stringify(install) !== JSON.stringify(lastInstall)) {
    console.error('[TTS] Install failed:', install)
  }
  lastInstall = install
}

function logServiceFailure(service: TtsServiceStatus): void {
  if (service.state === 'failed' && lastService.state !== 'failed') {
    console.error('[TTS] Service failed:', service)
  }
  if (service.modelState === 'failed' && lastService.modelState !== 'failed') {
    console.error('[TTS] Model load failed:', service)
  }
  lastService = service
}

export function characterVoiceStatus(character: TtsCharacter | null): CharacterVoiceStatus {
  const voice = character?.manifest?.voice
  if (!character || !voice) return { voice: 'unconfigured', missing: [], model: null }
  const dir = path.join(CHARACTERS_ROOT, character.characterId)
  const missing = [voice.gptWeights, voice.sovitsWeights].filter(file => !fs.existsSync(path.join(dir, file)))
  if (missing.length > 0) return { voice: 'missing', missing, model: null }
  return {
    voice: 'ok',
    missing: [],
    model: { gptWeights: path.join(dir, voice.gptWeights), sovitsWeights: path.join(dir, voice.sovitsWeights) },
  }
}

export function applyCharacterVoice(character: TtsCharacter | null): void {
  const current = manager
  if (current === null || !getTtsEnabled() || !current.status().installed) return
  const { model } = characterVoiceStatus(character)
  void (model === null ? current.loadModel(null) : current.startService(model))
}

export function applyTtsEnabled(enabled: boolean, character: TtsCharacter | null): void {
  setTtsEnabled(enabled)
  if (enabled) {
    applyCharacterVoice(character)
    return
  }
  void stopNarration()
  if (manager !== null) void manager.stopService()
}

export function initTts(root: string = VOICE_INSTALL_ROOT): void {
  const manifest = resolveManifestUrl()
  lastInstall = { state: 'idle' }
  lastService = { state: 'stopped', model: null, modelState: 'none' }
  updateCheckedAt = null
  manager = manifest === null
    ? null
    : createTtsManager({
        root,
        manifest,
        onState: status => {
          const serviceEnded = status.service.state !== lastService.state && (status.service.state === 'stopped' || status.service.state === 'failed')
          logInstallFailure(status.install)
          logServiceFailure(status.service)
          if (serviceEnded) void stopNarration()
          broadcastEvent('tts-status-changed', {})
        },
      })
}

export function getTtsManager(): TtsManager | null {
  return manager
}

export async function checkTtsUpdate(): Promise<void> {
  const current = manager
  if (current === null) return
  const status = current.status()
  if (!status.installed || status.source !== 'download') return
  if (updateCheckedAt !== null && Date.now() - updateCheckedAt < UPDATE_CHECK_CACHE_MS) return
  try {
    await current.checkUpdate({ signal: AbortSignal.timeout(REMOTE_MANIFEST_TIMEOUT_MS) })
    updateCheckedAt = Date.now()
  } catch (err) {
    console.error('[TTS] Update check failed:', err)
  }
}

export async function disposeTts(): Promise<void> {
  await manager?.dispose()
}
