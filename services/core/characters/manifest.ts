// services/core/characters/manifest.ts — 读取 assets/characters/<角色ID>/manifest.json，与默认值合并成 CharacterManifest，并检查其素材文件与转场链
// 用法：session/index.ts 的 loadSession 调 loadCharacterManifest(characterId)；导出 ASSET_ROOT / CHARACTERS_ROOT，index.ts 将后者挂为 /characters/ 静态目录；tts/manager.ts 与 tts/routes.ts 读 manifest.voice
// 对应文件：services/core/characters/transitionChain.ts / shared/portraitForm.ts / services/core/session/index.ts / services/core/routes/characterImport.ts / services/core/routes/transitionChain.ts / services/core/tts/manager.ts / services/core/tts/routes.ts / services/core/characters/manifest.test.ts
import fs from 'fs'
import path from 'path'
import os from 'os'
import * as dotenv from 'dotenv'
import { checkFileGroup, resolveTransitionChain } from './transitionChain.js'
import { isPortraitFormAvailable } from '../../../shared/portraitForm.js'

dotenv.config({ quiet: true })

export const ASSET_ROOT = path.resolve(process.cwd(), process.env.ASSET_PATH ?? './assets')
export const CHARACTERS_ROOT = path.join(ASSET_ROOT, 'characters')

if (process.env.VITEST && !ASSET_ROOT.startsWith(os.tmpdir() + path.sep)) {
  throw new Error(`[CharacterManifest] refusing ASSET_PATH "${ASSET_ROOT}" under vitest; it must resolve inside ${os.tmpdir()}`)
}

export interface PortraitForm {
  fallback: string
  emotions: Record<string, string[]>
  interactionStates: Record<string, string>
  reservedStates: Record<string, string[]>
}

export interface EmotePoolEntry {
  file: string
  tags: string[]
}

export interface CharacterVoicePreview {
  audio: string
  text: string
  lang: string
}

export interface CharacterVoice {
  gptWeights: string
  sovitsWeights: string
  preview: CharacterVoicePreview | null
}

export interface CharacterManifest {
  schemaVersion: number
  name: string
  displayName: string
  description: string
  tags: string[]
  creator: string
  version: string
  creatorNotes: string
  avatar: string
  userAvatar: string
  emotionVocabulary: string[]
  emoteTagVocabulary: string[]
  portraits: {
    pixel: PortraitForm
    illustration: PortraitForm
  }
  emotePool: EmotePoolEntry[]
  voice: CharacterVoice | null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function mergeOptionalString(value: unknown, label: string): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  console.warn(`[CharacterManifest] ${label} 类型错误，应为字符串，使用默认值 ''`)
  return ''
}

function mergeOptionalNumber(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback
  if (typeof value === 'number') return value
  console.warn(`[CharacterManifest] ${label} 类型错误，应为数字，使用默认值 ${fallback}`)
  return fallback
}

function mergeRequiredString(value: unknown, label: string): string {
  if (typeof value === 'string') return value
  console.warn(`[CharacterManifest] ${label} 缺失或类型错误，使用默认值 ''`)
  return ''
}

function mergeOptionalStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (isStringArray(value)) return value
  console.warn(`[CharacterManifest] ${label} 类型错误，应为字符串数组，使用默认值 []`)
  return []
}

function mergeStringMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    console.warn(`[CharacterManifest] ${label} 类型错误，应为对象，使用默认值 {}`)
    return {}
  }
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') {
      result[key] = entry
    } else {
      console.warn(`[CharacterManifest] ${label}.${key} 类型错误，应为字符串，忽略该条目`)
    }
  }
  return result
}

function mergeStringArrayMap(value: unknown, label: string): Record<string, string[]> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    console.warn(`[CharacterManifest] ${label} 类型错误，应为对象，使用默认值 {}`)
    return {}
  }
  const result: Record<string, string[]> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isStringArray(entry)) {
      result[key] = entry
    } else {
      console.warn(`[CharacterManifest] ${label}.${key} 类型错误，应为字符串数组，忽略该条目`)
    }
  }
  return result
}

function mergePortraitForm(value: unknown, label: string): PortraitForm {
  if (value === undefined) return { fallback: '', emotions: {}, interactionStates: {}, reservedStates: {} }
  const source = value as Record<string, unknown>
  return {
    fallback: mergeOptionalString(source.fallback, `${label}.fallback`),
    emotions: mergeStringArrayMap(source.emotions, `${label}.emotions`),
    interactionStates: mergeStringMap(source.interactionStates, `${label}.interactionStates`),
    reservedStates: mergeStringArrayMap(source.reservedStates, `${label}.reservedStates`),
  }
}

function mergeEmotePool(value: unknown): EmotePoolEntry[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    console.warn('[CharacterManifest] emotePool 类型错误，应为数组，使用默认值 []')
    return []
  }
  const result: EmotePoolEntry[] = []
  value.forEach((entry, index) => {
    const item = entry as Record<string, unknown>
    if (item && typeof item === 'object' && typeof item.file === 'string' && isStringArray(item.tags)) {
      result.push({ file: item.file, tags: item.tags })
    } else {
      console.warn(`[CharacterManifest] emotePool[${index}] 类型错误，忽略该条目`)
    }
  })
  return result
}

function isInsideFolder(folder: string, file: unknown): file is string {
  if (typeof file !== 'string' || file === '') return false
  if (path.win32.isAbsolute(file) || path.posix.isAbsolute(file)) return false
  const relative = path.relative(folder, path.resolve(folder, file))
  return !(relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
}

function mergeVoice(value: unknown, characterDir: string): CharacterVoice | null {
  if (value === undefined) return null
  const source = value as Record<string, unknown> | null
  const preview = source?.preview as Record<string, unknown> | null | undefined
  const valid =
    typeof source === 'object' && source !== null && !Array.isArray(source) &&
    isInsideFolder(characterDir, source.gptWeights) &&
    isInsideFolder(characterDir, source.sovitsWeights) &&
    (preview === undefined || (
      typeof preview === 'object' && preview !== null && !Array.isArray(preview) &&
      isInsideFolder(characterDir, preview.audio) &&
      typeof preview.text === 'string' &&
      (preview.lang === undefined || typeof preview.lang === 'string')
    ))
  if (!valid) {
    console.warn('[CharacterManifest] voice 类型错误或路径越出角色目录，该角色不朗读')
    return null
  }
  return {
    gptWeights: source.gptWeights as string,
    sovitsWeights: source.sovitsWeights as string,
    preview: preview === undefined
      ? null
      : { audio: preview.audio as string, text: preview.text as string, lang: (preview.lang as string | undefined) ?? 'zh' },
  }
}

function mergeManifest(raw: unknown, characterDir: string): CharacterManifest {
  const source = (raw ?? {}) as Record<string, unknown>
  const portraits = (source.portraits ?? {}) as Record<string, unknown>
  const emotionVocabulary = mergeOptionalStringArray(source.emotionVocabulary, 'emotionVocabulary')

  for (const legacyKey of ['interactionStates', 'reservedStates']) {
    if (source[legacyKey] !== undefined) {
      console.warn(`[CharacterManifest] 顶层 ${legacyKey} 是旧格式，已不再读取；请移到 portraits.<形态>.${legacyKey} 下`)
    }
  }

  return {
    schemaVersion: mergeOptionalNumber(source.schemaVersion, 1, 'schemaVersion'),
    name: mergeOptionalString(source.name, 'name'),
    displayName: mergeOptionalString(source.displayName, 'displayName'),
    description: mergeOptionalString(source.description, 'description'),
    tags: mergeOptionalStringArray(source.tags, 'tags'),
    creator: mergeOptionalString(source.creator, 'creator'),
    version: mergeOptionalString(source.version, 'version'),
    creatorNotes: mergeOptionalString(source.creatorNotes, 'creatorNotes'),
    avatar: mergeRequiredString(source.avatar, 'avatar'),
    userAvatar: mergeOptionalString(source.userAvatar, 'userAvatar'),
    emotionVocabulary,
    emoteTagVocabulary: mergeOptionalStringArray(source.emoteTagVocabulary, 'emoteTagVocabulary'),
    portraits: {
      pixel: mergePortraitForm(portraits.pixel, 'portraits.pixel'),
      illustration: mergePortraitForm(portraits.illustration, 'portraits.illustration'),
    },
    emotePool: mergeEmotePool(source.emotePool),
    voice: mergeVoice(source.voice, characterDir),
  }
}

function checkManifestAssets(characterId: string, raw: unknown, manifest: CharacterManifest): void {
  const characterDir = path.join(CHARACTERS_ROOT, characterId)
  const label = `角色 ${characterId}`

  for (const form of ['pixel', 'illustration'] as const) {
    for (const [key, files] of Object.entries(manifest.portraits[form].emotions)) {
      checkFileGroup(characterDir, files, `${label} portraits.${form}.emotions.${key}`)
    }
    for (const [key, file] of Object.entries(manifest.portraits[form].interactionStates)) {
      checkFileGroup(characterDir, [file], `${label} portraits.${form}.interactionStates.${key}`)
    }
    for (const [key, files] of Object.entries(manifest.portraits[form].reservedStates)) {
      checkFileGroup(characterDir, files, `${label} portraits.${form}.reservedStates.${key}`)
    }
  }

  const transitions = (raw as Record<string, unknown> | null)?.transitions
  if (typeof transitions !== 'object' || transitions === null || Array.isArray(transitions)) return
  for (const trigger of Object.keys(transitions)) {
    for (const form of ['pixel', 'illustration'] as const) {
      if (!isPortraitFormAvailable(manifest.portraits[form])) continue
      resolveTransitionChain({ characterId, characterDir, raw, trigger, form })
    }
  }
}

export function loadCharacterManifest(characterId: string): CharacterManifest | null {
  const manifestPath = path.join(CHARACTERS_ROOT, characterId, 'manifest.json')

  let text: string
  try {
    text = fs.readFileSync(manifestPath, 'utf-8')
  } catch (err) {
    console.warn(`[CharacterManifest] 角色包不可用，manifest.json 不存在: ${characterId}`, err)
    return null
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    console.warn(`[CharacterManifest] 角色包不可用，manifest.json 解析失败: ${characterId}`, err)
    return null
  }

  const manifest = mergeManifest(raw, path.join(CHARACTERS_ROOT, characterId))
  checkManifestAssets(characterId, raw, manifest)
  return manifest
}
