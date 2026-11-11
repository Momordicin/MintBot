// services/core/roleConfig/recognize.ts — 另起一个临时语音插件进程，按 4 倍速识别一个 wav，返回替换前的原文
// 用法：roleConfig/collect.ts 调 recognizeWav(wavPath, signal)
// 对应文件：services/core/roleConfig/collect.ts / services/core/roleConfig/tts.ts / services/core/voice/install.ts
import fs from 'fs'
import { startAgentProcess } from '@mintbot/voice-agent-client'
import { readVoiceInstallation } from '../voice/install.js'

const REPLAY_SPEED = 4
const WAV_HEADER_BYTES = 44
const WAV_BYTES_PER_SECOND = 16000 * 2
const END_GRACE_MS = 2000
const HARD_TIMEOUT_EXTRA_MS = 15_000

function finalText(data: { text_raw?: unknown; text?: unknown } | null | undefined): string | null {
  for (const value of [data?.text_raw, data?.text]) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

export async function recognizeWav(wavPath: string, signal: AbortSignal): Promise<string | null> {
  const installation = await readVoiceInstallation()
  if (!installation) throw new Error('语音插件未安装')
  const { size } = await fs.promises.stat(wavPath)
  const wavSeconds = Math.max(0, size - WAV_HEADER_BYTES) / WAV_BYTES_PER_SECOND

  const agent = await startAgentProcess({
    file: installation.exe,
    args: ['--vad', installation.vad, '-m', installation.asr, '--source', `wav:${wavPath}`, '--replay-speed', String(REPLAY_SPEED), '--autostart'],
  })
  const stop = new AbortController()
  const onAbort = () => stop.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) stop.abort()
  const hardTimer = setTimeout(() => stop.abort(), (wavSeconds / REPLAY_SPEED) * 1000 + HARD_TIMEOUT_EXTRA_MS)
  let endTimer: ReturnType<typeof setTimeout> | null = null
  try {
    for await (const ev of await agent.openEvents(stop.signal)) {
      if (ev.type === 'final') {
        const text = finalText(ev.data)
        if (text !== null) return text
      } else if (
        (ev.type === 'device' && ev.data?.state === 'ended') ||
        (ev.type === 'capture' && ev.data?.state === 'stopped')
      ) {
        endTimer ??= setTimeout(() => stop.abort(), END_GRACE_MS)
      }
    }
    return null
  } catch (err) {
    if (signal.aborted) throw err
    if (stop.signal.aborted) return null
    throw err
  } finally {
    clearTimeout(hardTimer)
    if (endTimer) clearTimeout(endTimer)
    signal.removeEventListener('abort', onAbort)
    await agent.shutdown()
  }
}
