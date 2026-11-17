// services/core/tts/voiceRefs.ts — 按情绪分的参考音频：扫描角色语音文件夹下的分组，请当前预设的聊天模型把情绪词对到分组并存档，朗读时按情绪取参考音频
// 用法：session/index.ts 的 loadSession 调 loadVoiceReferences()；tts/routes.ts 的 GET /tts/status 调 getVoiceReferencesStatus()，POST /tts/references/rematch 调 rematchVoiceReferences()；loadVoiceReferences() 与 rematchVoiceReferences() 都传入当前预设与密钥；tts/narration.ts 调 voiceReferenceFor()；状态变化时 broadcastEvent('tts-status-changed')；存档目录取环境变量 VOICE_REFERENCES_PATH，默认 ./data/voice-references
// 对应文件：services/core/session/index.ts / services/core/tts/routes.ts / services/core/tts/narration.ts / services/core/tts/manager.ts / services/core/characters/manifest.ts / services/core/config/index.ts / services/core/providers/ModelProvider.ts / services/core/session/queries.ts / services/core/util/jsonSalvage.ts / services/core/events/broadcast.ts / vitest.setup.ts / services/core/tts/voiceRefs.test.ts
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as dotenv from 'dotenv'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { BuiltContext, Preset } from '../../../shared/types/index.js'
import { CHARACTERS_ROOT } from '../characters/manifest.js'
import { getModelProviderConfig } from '../config/index.js'
import { broadcastEvent } from '../events/broadcast.js'
import { createModelProviderForPreset, stripThinkTags } from '../providers/ModelProvider.js'
import type { PresetCredentials } from '../session/queries.js'
import { parseJsonSalvage } from '../util/jsonSalvage.js'
import { characterVoiceStatus, type TtsCharacter } from './manager.js'

dotenv.config({ quiet: true })

export const VOICE_REFERENCES_DIR = path.resolve(process.cwd(), process.env.VOICE_REFERENCES_PATH ?? './data/voice-references')

if (process.env.VITEST && !VOICE_REFERENCES_DIR.startsWith(os.tmpdir() + path.sep)) {
  throw new Error(`[VoiceRefs] refusing VOICE_REFERENCES_PATH "${VOICE_REFERENCES_DIR}" under vitest; it must resolve inside ${os.tmpdir()}`)
}

const MIN_SECONDS = 3
const MAX_SECONDS = 10
const HEADER_BYTES = 65536
const MAX_ATTEMPTS = 2
const NO_TEXT_STEM = /^[A-Za-z0-9_-]*$/
const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'])

export type VoiceReferenceSkipReason = 'missing_text' | 'duration' | 'invalid_wav'
export type VoiceReferenceFailure = 'network' | 'model_error' | 'invalid_answer'
export type VoiceReferenceEntry = { emotion: string; group: string; clip: string } | { emotion: string; group: null }

export interface VoiceReferencesStatus {
  state: 'none' | 'matching' | 'ok' | 'failed'
  error?: VoiceReferenceFailure
  entries: VoiceReferenceEntry[]
  skipped: { path: string; reason: VoiceReferenceSkipReason }[]
}

export interface VoiceReferenceModel {
  preset: Preset
  credentials: PresetCredentials
}

export interface VoiceReference {
  refAudio: string
  refText: string
  lang: string
}

interface Clip {
  file: string
  audio: string
  text: string
}

type Mapping = Record<string, string | null>
type MatchResult = { ok: true; mapping: Mapping } | { ok: false; error: VoiceReferenceFailure }

interface CharacterReferences {
  characterId: string
  emotions: string[]
  groups: Map<string, Clip | null>
  skipped: VoiceReferencesStatus['skipped']
  lang: string
  key: string
  state: VoiceReferencesStatus['state']
  error?: VoiceReferenceFailure
  mapping: Mapping | null
  model: VoiceReferenceModel
}

let current: CharacterReferences | null = null
const matching = new Set<string>()

function wavSeconds(file: string): number | null {
  let header: Buffer
  let fileSize: number
  try {
    const fd = fs.openSync(file, 'r')
    try {
      fileSize = fs.fstatSync(fd).size
      header = Buffer.alloc(HEADER_BYTES)
      header = header.subarray(0, fs.readSync(fd, header, 0, HEADER_BYTES, 0))
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  if (header.length < 12 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return null
  let byteRate: number | null = null
  let offset = 12
  while (offset + 8 <= header.length) {
    const id = header.toString('ascii', offset, offset + 4)
    const size = header.readUInt32LE(offset + 4)
    const start = offset + 8
    if (id === 'fmt ' && start + 12 <= header.length) byteRate = header.readUInt32LE(start + 8)
    if (id === 'data') return byteRate ? Math.min(size, fileSize - start) / byteRate : null
    offset = start + size + (size & 1)
  }
  return null
}

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  } catch {
    return []
  }
}

function scanGroups(voiceDir: string): Pick<CharacterReferences, 'groups' | 'skipped'> {
  const groups = new Map<string, Clip | null>()
  const skipped: CharacterReferences['skipped'] = []
  for (const group of listDir(voiceDir).filter(entry => entry.isDirectory())) {
    let chosen: Clip | null = null
    for (const entry of listDir(path.join(voiceDir, group.name))) {
      if (!entry.isFile() || !/\.wav$/i.test(entry.name)) continue
      const file = `${group.name}/${entry.name}`
      const stem = entry.name.slice(0, -4)
      if (NO_TEXT_STEM.test(stem)) {
        skipped.push({ path: file, reason: 'missing_text' })
        continue
      }
      const audio = path.join(voiceDir, group.name, entry.name)
      const seconds = wavSeconds(audio)
      if (seconds === null) {
        skipped.push({ path: file, reason: 'invalid_wav' })
      } else if (seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
        skipped.push({ path: file, reason: 'duration' })
      } else if (chosen === null) {
        chosen = { file, audio, text: stem }
      }
    }
    groups.set(group.name, chosen)
  }
  return { groups, skipped }
}

function prepare(character: TtsCharacter | null, model: VoiceReferenceModel | null): CharacterReferences | null {
  const manifest = character?.manifest
  const voice = manifest?.voice
  if (!character || !model || !manifest || !voice || characterVoiceStatus(character).voice !== 'ok') return null
  const voiceDir = path.dirname(path.join(CHARACTERS_ROOT, character.characterId, voice.gptWeights))
  const { groups, skipped } = scanGroups(voiceDir)
  const emotions = [...manifest.emotionVocabulary]
  return {
    characterId: character.characterId,
    emotions,
    groups,
    skipped,
    lang: voice.preview?.lang ?? 'zh',
    key: JSON.stringify([[...emotions].sort(), [...groups.keys()].sort()]),
    state: groups.size === 0 ? 'none' : 'matching',
    mapping: null,
    model,
  }
}

function mappedGroup(mapping: Mapping, emotion: string): string | null {
  return Object.hasOwn(mapping, emotion) ? mapping[emotion] : null
}

function validateMapping(value: unknown, emotions: readonly string[], groups: readonly string[]): Mapping | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const mapping: Mapping = {}
  for (const [emotion, group] of Object.entries(value)) {
    if (!emotions.includes(emotion)) return null
    if (group !== null && (typeof group !== 'string' || !groups.includes(group))) return null
    mapping[emotion] = group
  }
  return emotions.every(emotion => Object.hasOwn(mapping, emotion)) ? mapping : null
}

function savedFile(characterId: string): string {
  return path.join(VOICE_REFERENCES_DIR, `${characterId}.json`)
}

function readSaved(refs: CharacterReferences): Mapping | null {
  const file = savedFile(refs.characterId)
  if (!fs.existsSync(file)) return null
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as { key?: unknown; mapping?: unknown }
    if (saved.key !== refs.key) return null
    return validateMapping(saved.mapping, refs.emotions, [...refs.groups.keys()])
  } catch (err) {
    console.warn(`[VoiceRefs] Saved matching for ${refs.characterId} is unreadable, matching again:`, err)
    return null
  }
}

function save(characterId: string, key: string, mapping: Mapping): void {
  try {
    fs.mkdirSync(VOICE_REFERENCES_DIR, { recursive: true })
    fs.writeFileSync(savedFile(characterId), JSON.stringify({ key, mapping, at: Date.now() }, null, 2), 'utf-8')
  } catch (err) {
    console.error(`[VoiceRefs] Saving the matching for ${characterId} failed:`, err)
  }
}

function isNetworkError(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError || err instanceof OpenAI.APIConnectionError) return true
  let cause: unknown = err
  for (let depth = 0; depth < 5 && cause instanceof Error; depth++) {
    const code = (cause as { code?: unknown }).code
    if (typeof code === 'string' && CONNECTION_ERROR_CODES.has(code)) return true
    cause = cause.cause
  }
  return false
}

function matchingContext(emotions: readonly string[], groups: readonly string[]): BuiltContext {
  return {
    system: [
      '把每个情绪词对应到一个最贴近的参考音频分组名，没有合适的分组就写 null。',
      '只输出一个 JSON 对象：键是情绪词，值是分组名或 null，不要输出其它文字。',
    ].join('\n'),
    messages: [{ role: 'user', content: `情绪词：${JSON.stringify(emotions)}\n分组名：${JSON.stringify(groups)}` }],
  }
}

async function requestMapping(characterId: string, model: VoiceReferenceModel, emotions: readonly string[], groups: readonly string[]): Promise<MatchResult> {
  if (emotions.length === 0) return { ok: true, mapping: {} }
  let error: VoiceReferenceFailure = 'model_error'
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const raw = await createModelProviderForPreset(model.preset, getModelProviderConfig(), model.credentials).completeSync(matchingContext(emotions, groups))
      const mapping = validateMapping(parseJsonSalvage(stripThinkTags(raw)), emotions, groups)
      if (mapping !== null) return { ok: true, mapping }
      error = 'invalid_answer'
      console.error(`[VoiceRefs] Invalid matching answer for ${characterId} (attempt ${attempt}):`, JSON.stringify(raw))
    } catch (err) {
      error = isNetworkError(err) ? 'network' : 'model_error'
      console.error(`[VoiceRefs] Matching request for ${characterId} failed (attempt ${attempt}):`, err)
    }
  }
  return { ok: false, error }
}

function statusOf(refs: CharacterReferences | null): VoiceReferencesStatus {
  if (refs === null) return { state: 'none', entries: [], skipped: [] }
  const mapping = refs.state === 'ok' ? refs.mapping ?? {} : null
  const entries: VoiceReferenceEntry[] = mapping === null
    ? []
    : refs.emotions.map(emotion => {
        const group = mappedGroup(mapping, emotion)
        const clip = group === null ? null : refs.groups.get(group) ?? null
        return group === null || clip === null ? { emotion, group: null } : { emotion, group, clip: clip.file }
      })
  return {
    state: refs.state,
    ...(refs.state === 'failed' && refs.error ? { error: refs.error } : {}),
    entries,
    skipped: refs.skipped,
  }
}

function update(change: () => void): void {
  const before = JSON.stringify(statusOf(current))
  change()
  if (JSON.stringify(statusOf(current)) !== before) broadcastEvent('tts-status-changed', {})
}

function startMatching(refs: CharacterReferences): void {
  refs.state = 'matching'
  refs.mapping = null
  delete refs.error
  if (matching.has(refs.characterId)) return
  matching.add(refs.characterId)
  void requestMapping(refs.characterId, refs.model, refs.emotions, [...refs.groups.keys()]).then(result => {
    matching.delete(refs.characterId)
    if (result.ok) save(refs.characterId, refs.key, result.mapping)
    const live = current
    if (live === null || live.characterId !== refs.characterId || live.state !== 'matching') return
    update(() => {
      if (live.key !== refs.key) {
        startMatching(live)
      } else if (result.ok) {
        live.state = 'ok'
        live.mapping = result.mapping
      } else {
        live.state = 'failed'
        live.error = result.error
      }
    })
  })
}

function begin(refs: CharacterReferences | null, useSaved: boolean): void {
  current = refs
  if (refs === null || refs.state !== 'matching') return
  const saved = useSaved && !matching.has(refs.characterId) ? readSaved(refs) : null
  if (saved === null) {
    startMatching(refs)
    return
  }
  refs.state = 'ok'
  refs.mapping = saved
}

export function loadVoiceReferences(character: TtsCharacter | null, model: VoiceReferenceModel | null): void {
  update(() => begin(prepare(character, model), true))
}

export function rematchVoiceReferences(character: TtsCharacter | null, model: VoiceReferenceModel | null): 'started' | 'busy' {
  if (character !== null && matching.has(character.characterId)) return 'busy'
  update(() => begin(prepare(character, model), false))
  return 'started'
}

export function getVoiceReferencesStatus(): VoiceReferencesStatus {
  return statusOf(current)
}

export function voiceReferenceFor(characterId: string, emotion: string | null): VoiceReference | null {
  const refs = current
  if (emotion === null || refs === null || refs.characterId !== characterId || refs.state !== 'ok' || refs.mapping === null) return null
  const group = mappedGroup(refs.mapping, emotion)
  const clip = group === null ? null : refs.groups.get(group) ?? null
  if (clip === null) return null
  return { refAudio: clip.audio, refText: clip.text, lang: refs.lang }
}
