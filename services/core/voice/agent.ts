// services/core/voice/agent.ts — 托管语音输入进程：转写结果追加到本地记录，并累积为待放入聊天输入框的文字
// 用法：index.ts 的 start() 调 startVoice()，SIGINT/SIGTERM 时调 stopVoice()；voice/routes.ts 调 takePending()；有新文字时 broadcastEvent('voice-pending')
// 对应文件：services/core/voice/install.ts / services/core/voice/routes.ts / services/core/events/broadcast.ts / services/core/voice/agent.test.ts
import fs from 'fs'
import path from 'path'
import { VoiceAgentSupervisor, type AgentEvent } from '@mintbot/voice-agent-client'
import { broadcastEvent } from '../events/broadcast.js'
import { readVoiceInstallation } from './install.js'

export const VOICE_DATA_DIR = path.resolve(process.cwd(), 'data', 'voice')

let supervisor: VoiceAgentSupervisor | null = null
let transcriptsPath = path.join(VOICE_DATA_DIR, 'transcripts.jsonl')
let pending: string[] = []

export function takePending(): string[] {
  const texts = pending
  pending = []
  return texts
}

function handleEvent(ev: AgentEvent): void {
  if (ev.type !== 'final') return
  const data = ev.data ?? {}
  if (data.enrolling === true) return
  const text = data.text
  if (typeof text !== 'string' || text.trim() === '') return

  const record: Record<string, unknown> = {
    at: data.end_unix_ms,
    text,
    language: data.language,
    emotion: data.emotion,
  }
  if (data.speaker_score !== undefined) record.speaker_score = data.speaker_score
  if (data.is_owner !== undefined) record.is_owner = data.is_owner
  try {
    fs.appendFileSync(transcriptsPath, JSON.stringify(record) + '\n')
  } catch (err) {
    console.error('[Voice] Failed to append transcript:', err, record)
  }

  pending.push(text)
  broadcastEvent('voice-pending', {})
}

export async function startVoice(dataDir: string = VOICE_DATA_DIR): Promise<void> {
  fs.mkdirSync(dataDir, { recursive: true })
  transcriptsPath = path.join(dataDir, 'transcripts.jsonl')

  const installation = await readVoiceInstallation()
  if (!installation) {
    console.log('[Voice] 语音组件未安装，运行 pnpm setup:voice --manifest <路径或网址> 安装')
    return
  }

  supervisor = new VoiceAgentSupervisor({
    installation,
    voiceprintPath: path.join(dataDir, 'owner.voiceprint.json'),
    onEvent: handleEvent,
  })
  await supervisor.start()
}

export async function stopVoice(): Promise<void> {
  const current = supervisor
  supervisor = null
  if (!current) return
  try {
    await current.stop()
  } catch (err) {
    console.error('[Voice] Failed to stop voice agent:', err)
  }
}
