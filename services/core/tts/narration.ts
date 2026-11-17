// services/core/tts/narration.ts — 朗读角色回复：去掉括号内的动作描写、按回复的情绪选参考音频，逐句合成并交给语音组件按顺序播放，停止朗读，记录上次朗读失败
// 用法：routes/chat.ts 在 message_done 后调 narrateReply(text, character, emotion)，参考音频取 tts/voiceRefs.ts 的 voiceReferenceFor()；session/index.ts 的 loadSession、tts/manager.ts 的 applyTtsEnabled() 与服务停止或失败、tts/routes.ts 的 POST /tts/preview 与 POST /tts/narration/stop 调 stopNarration()；tts/routes.ts 调 isSpeaking() / getNarrationLastError()；朗读状态变化时 broadcastEvent('narration-changed', { speaking })，上次失败变化时 broadcastEvent('tts-status-changed')
// 对应文件：services/core/tts/manager.ts / services/core/tts/voiceRefs.ts / services/core/tts/routes.ts / services/core/voice/agent.ts / services/core/routes/chat.ts / services/core/session/index.ts / services/core/events/broadcast.ts / services/core/tts/narration.test.ts
import path from 'path'
import { AgentHttpError, PlaybackError, TtsError, type PlaybackEvent } from '@mintbot/voice-agent-client'
import { CHARACTERS_ROOT } from '../characters/manifest.js'
import { getTtsEnabled } from '../config/index.js'
import { broadcastEvent } from '../events/broadcast.js'
import { getPlaybackSupported, playClip, setPlaybackListener, stopPlayback, VoiceOperationError } from '../voice/agent.js'
import { characterVoiceStatus, getTtsManager, type TtsCharacter } from './manager.js'
import { voiceReferenceFor } from './voiceRefs.js'

const ENDED_BUFFER_LIMIT = 16
const FAILURE_SILENCE_RATE = 16000

export interface NarrationError {
  code: string
  message: string
  status?: number
  at: number
}

interface NarrationVoice {
  refAudio: string
  refText: string
  lang: string
}

interface QueueItem {
  text: string
  gen: number
  voice: NarrationVoice
}

let queue: QueueItem[] = []
let gen = 0
let working = false
let synthesizingGen: number | null = null
let playInFlight: Promise<unknown> | null = null
let playing = new Set<number>()
let endedBeforeKnown: number[] = []
let lastError: NarrationError | null = null
let lastSpeaking = false

export function splitSentences(text: string): string[] {
  return text
    .replace(/（[^（）]*）/g, '')
    .replace(/\([^()]*\)/g, '')
    .split(/[。！？!?；;…\r\n]/)
    .map(piece => piece.trim())
    .filter(piece => piece.replace(/[\p{P}\p{S}\s]/gu, '') !== '')
}

export function isFailureSilence(wav: Buffer): boolean {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return false
  let sampleRate: number | null = null
  let offset = 12
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    const start = offset + 8
    if (id === 'fmt ' && start + 8 <= wav.length) sampleRate = wav.readUInt32LE(start + 4)
    if (id === 'data') {
      if (sampleRate !== FAILURE_SILENCE_RATE) return false
      const end = Math.min(start + size, wav.length)
      for (let i = start; i < end; i++) if (wav[i] !== 0) return false
      return true
    }
    offset = start + size + (size & 1)
  }
  return false
}

export function isSpeaking(): boolean {
  return queue.length > 0 || synthesizingGen === gen || playInFlight !== null || playing.size > 0
}

export function getNarrationLastError(): NarrationError | null {
  return lastError
}

function notifySpeaking(): void {
  const speaking = isSpeaking()
  if (speaking === lastSpeaking) return
  lastSpeaking = speaking
  broadcastEvent('narration-changed', { speaking })
}

function setLastError(next: NarrationError | null): void {
  if (next === null && lastError === null) return
  lastError = next
  broadcastEvent('tts-status-changed', {})
}

function errorMessage(err: unknown): string {
  if (err instanceof TtsError) {
    const details = err.details
    const parts = [details.message, details.exception].filter((part): part is string => typeof part === 'string' && part !== '')
    if (parts.length > 0) return parts.join('：')
    if (typeof details.status === 'number') return `HTTP ${details.status}`
    return err.code
  }
  return err instanceof Error ? err.message : String(err)
}

function synthesisError(err: unknown): NarrationError {
  const code = err instanceof TtsError ? err.code : 'TTS_SYNTHESIS'
  return { code, message: errorMessage(err), at: Date.now() }
}

function playbackError(err: unknown): NarrationError {
  const message = errorMessage(err)
  const at = Date.now()
  if (err instanceof PlaybackError) return { code: err.code, message, at }
  if (err instanceof AgentHttpError) return { code: 'AGENT_HTTP', message, status: err.status, at }
  if (err instanceof VoiceOperationError) return { code: err.errorCode, message, at }
  return { code: 'AGENT_UNREACHABLE', message, at }
}

function fail(label: string, err: unknown, text: string, error: NarrationError): void {
  console.error(`[Narration] ${label}:`, err, text)
  setLastError(error)
}

function narrationVoice(character: TtsCharacter, emotion: string | null): NarrationVoice | null {
  const preview = character.manifest?.voice?.preview
  if (characterVoiceStatus(character).voice !== 'ok' || !preview) return null
  return voiceReferenceFor(character.characterId, emotion) ?? {
    refAudio: path.join(CHARACTERS_ROOT, character.characterId, preview.audio),
    refText: preview.text,
    lang: preview.lang,
  }
}

function canNarrate(): boolean {
  const manager = getTtsManager()
  if (manager === null || !getTtsEnabled()) return false
  const { service } = manager.status()
  return service.state === 'running' && service.modelState === 'loaded' && getPlaybackSupported() === true
}

function markEnded(id: number): void {
  if (playing.delete(id)) return
  endedBeforeKnown.push(id)
  if (endedBeforeKnown.length > ENDED_BUFFER_LIMIT) endedBeforeKnown.shift()
}

function markQueued(id: number): void {
  const index = endedBeforeKnown.indexOf(id)
  if (index >= 0) endedBeforeKnown.splice(index, 1)
  else playing.add(id)
}

async function playItem(item: QueueItem, wav: Buffer): Promise<'next' | 'drop'> {
  const request = playClip(wav)
  playInFlight = request.catch(() => {})
  try {
    markQueued(await request)
    return 'next'
  } catch (err) {
    fail('Playback failed', err, item.text, playbackError(err))
    return err instanceof PlaybackError && err.code === 'PLAYBACK_UNSUPPORTED_WAV' ? 'next' : 'drop'
  } finally {
    playInFlight = null
  }
}

async function work(): Promise<void> {
  if (working) return
  working = true
  try {
    while (queue.length > 0) {
      const item = queue.shift()!
      const manager = getTtsManager()
      if (manager === null) continue
      synthesizingGen = item.gen
      let wav: Buffer
      try {
        wav = await manager.synthesize({
          text: item.text,
          textLang: item.voice.lang,
          refAudio: item.voice.refAudio,
          refText: item.voice.refText,
          promptLang: item.voice.lang,
        })
      } catch (err) {
        synthesizingGen = null
        if (item.gen === gen) fail('Synthesis failed', err, item.text, synthesisError(err))
        notifySpeaking()
        continue
      }
      synthesizingGen = null
      if (item.gen !== gen) {
        notifySpeaking()
        continue
      }
      if (isFailureSilence(wav)) {
        console.error('[Narration] Synthesis returned failure silence:', item.text)
        setLastError({ code: 'TTS_SILENT', message: '', at: Date.now() })
        notifySpeaking()
        continue
      }
      if ((await playItem(item, wav)) === 'drop') queue = []
      notifySpeaking()
    }
  } finally {
    working = false
    notifySpeaking()
  }
}

export function narrateReply(text: string, character: TtsCharacter, emotion: string | null = null): void {
  try {
    if (!canNarrate()) return
    const voice = narrationVoice(character, emotion)
    if (voice === null) return
    const sentences = splitSentences(text)
    if (sentences.length === 0) return
    for (const sentence of sentences) queue.push({ text: sentence, gen, voice })
    notifySpeaking()
    void work()
  } catch (err) {
    console.error('[Narration] Failed to start reading the reply:', err, text)
  }
}

export async function stopNarration(): Promise<void> {
  gen++
  queue = []
  notifySpeaking()
  await playInFlight
  if (getPlaybackSupported() !== true) return
  const stopped = [...playing]
  try {
    await stopPlayback()
  } catch (err) {
    console.error('[Narration] Failed to stop playback:', err)
  }
  for (const id of stopped) playing.delete(id)
  notifySpeaking()
}

setPlaybackListener({
  onPlayback(ev: PlaybackEvent) {
    if (typeof ev.id !== 'number') return
    if (ev.state === 'end' || ev.state === 'stopped') {
      markEnded(ev.id)
      if (ev.state === 'end') setLastError(null)
      notifySpeaking()
    }
  },
  onPlaybackFailed(message: string) {
    console.error('[Narration] Playback failed on the output device:', message)
    setLastError({ code: 'playback_failed', message, at: Date.now() })
  },
  onPlaybackIdle() {
    if (playInFlight !== null || playing.size === 0) return
    playing = new Set()
    notifySpeaking()
  },
  onLeftRunning() {
    gen++
    queue = []
    playing = new Set()
    endedBeforeKnown = []
    notifySpeaking()
  },
})
