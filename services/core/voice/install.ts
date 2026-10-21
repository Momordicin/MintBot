// services/core/voice/install.ts — 语音组件（mintbot-voice-agent）的安装目录常量，以及安装、读取安装信息、读取远端版本、清理旧版本目录
// 用法：scripts/setup-voice.ts 调 installVoice(manifest)；voice/agent.ts 调 readVoiceInstallation()、fetchRemoteManifestInfo()、removeStaleVoiceVersions()
// 对应文件：services/core/voice/agent.ts / scripts/setup-voice.ts / services/core/voice/agent.test.ts
import fs from 'fs'
import path from 'path'
import {
  API_VERSION,
  installVoiceAgent,
  readInstallation,
  staleVersions,
  type Installation,
  type InstallOptions,
} from '@mintbot/voice-agent-client'

export const VOICE_INSTALL_ROOT = path.resolve(process.cwd(), 'data', 'voice-agent')

export const PINNED_MANIFEST_URL: string | null =
  'https://github.com/Momordicin/mintbot-voice-agent/releases/latest/download/manifest.json'

const REMOTE_MANIFEST_TIMEOUT_MS = 10_000

export interface RemoteManifestInfo {
  version: string
  apiVersion: number
}

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

export async function fetchRemoteManifestInfo(manifest: string): Promise<RemoteManifestInfo> {
  let raw: string
  if (/^https?:\/\//i.test(manifest)) {
    const response = await fetch(manifest, { signal: AbortSignal.timeout(REMOTE_MANIFEST_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    raw = await response.text()
  } else {
    raw = await fs.promises.readFile(manifest, 'utf-8')
  }
  const parsed = JSON.parse(raw) as { version?: unknown; api_version?: unknown }
  if (typeof parsed.version !== 'string' || typeof parsed.api_version !== 'number') {
    throw new Error('manifest missing version or api_version')
  }
  return { version: parsed.version, apiVersion: parsed.api_version }
}

export async function removeStaleVoiceVersions(root: string = VOICE_INSTALL_ROOT): Promise<void> {
  for (const dir of await staleVersions(root)) {
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
}
