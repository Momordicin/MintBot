// services/core/voice/install.ts — 语音组件（mintbot-voice-agent）的安装目录常量，以及安装与读取安装信息
// 用法：scripts/setup-voice.ts 调 installVoice(manifest)；voice/agent.ts 的 startVoice() 调 readVoiceInstallation()
// 对应文件：services/core/voice/agent.ts / scripts/setup-voice.ts / services/core/voice/agent.test.ts
import path from 'path'
import {
  API_VERSION,
  installVoiceAgent,
  readInstallation,
  type Installation,
  type InstallOptions,
} from '@mintbot/voice-agent-client'

export const VOICE_INSTALL_ROOT = path.resolve(process.cwd(), 'data', 'voice-agent')

export const PINNED_MANIFEST_URL: string | null =
  'https://github.com/Momordicin/mintbot-voice-agent/releases/download/v0.1.1/manifest.json'

export function resolveManifestUrl(): string | null {
  const fromEnv = process.env.MINTBOT_VOICE_MANIFEST?.trim()
  return fromEnv ? fromEnv : PINNED_MANIFEST_URL
}

export function installVoice(
  manifest: string,
  onProgress?: (msg: string) => void,
  extra: Pick<InstallOptions, 'onStep' | 'signal'> = {}
): Promise<Installation> {
  return installVoiceAgent({ manifest, root: VOICE_INSTALL_ROOT, apiVersion: API_VERSION, onProgress, ...extra })
}

export function readVoiceInstallation(): Promise<Installation | null> {
  return readInstallation(VOICE_INSTALL_ROOT, { apiVersion: API_VERSION })
}
