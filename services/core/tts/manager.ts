// services/core/tts/manager.ts — 持有语音合成组件（GPT-SoVITS）的管理器：创建、状态变化广播、检查新版本、退出时释放
// 用法：core/index.ts 的 start() 调 initTts()，SIGINT/SIGTERM 时调 disposeTts()；tts/routes.ts 调 getTtsManager()、TTS_DEFAULT_ROOT；voice/routes.ts 的 GET /voice/update-check 调 checkTtsUpdate()；状态变化时 broadcastEvent('tts-status-changed')
// 对应文件：services/core/tts/routes.ts / services/core/voice/install.ts / services/core/voice/routes.ts / services/core/events/broadcast.ts / services/core/index.ts / services/core/tts/routes.test.ts
import path from 'path'
import { createTtsManager, type TtsInstallStatus, type TtsManager } from '@mintbot/voice-agent-client'
import { broadcastEvent } from '../events/broadcast.js'
import { REMOTE_MANIFEST_TIMEOUT_MS, VOICE_INSTALL_ROOT, resolveManifestUrl } from '../voice/install.js'

export const TTS_DEFAULT_ROOT = path.resolve(process.cwd(), 'data', 'tts')

const UPDATE_CHECK_CACHE_MS = 10 * 60 * 1000

let manager: TtsManager | null = null
let lastInstall: TtsInstallStatus = { state: 'idle' }
let updateCheckedAt: number | null = null

function logInstallFailure(install: TtsInstallStatus): void {
  if (install.state === 'failed' && JSON.stringify(install) !== JSON.stringify(lastInstall)) {
    console.error('[TTS] Install failed:', install)
  }
  lastInstall = install
}

export function initTts(root: string = VOICE_INSTALL_ROOT): void {
  const manifest = resolveManifestUrl()
  lastInstall = { state: 'idle' }
  updateCheckedAt = null
  manager = manifest === null
    ? null
    : createTtsManager({
        root,
        manifest,
        onState: status => {
          logInstallFailure(status.install)
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
