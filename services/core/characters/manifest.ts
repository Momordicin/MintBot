import fs from 'fs'
import path from 'path'
import os from 'os'
import * as dotenv from 'dotenv'
import { logAssetProblems, validateManifestAssets } from './manifestAssets.js'

dotenv.config({ quiet: true })

export const ASSET_ROOT = path.resolve(process.cwd(), process.env.ASSET_PATH ?? './assets')
export const CHARACTERS_ROOT = path.join(ASSET_ROOT, 'characters')

if (process.env.VITEST && !ASSET_ROOT.startsWith(os.tmpdir() + path.sep)) {
  throw new Error(`[CharacterManifest] refusing ASSET_PATH "${ASSET_ROOT}" under vitest; it must resolve inside ${os.tmpdir()}`)
}

export interface PortraitForm {
  fallback: string
  emotions: Record<string, string[]>
}

export interface EmotePoolEntry {
  file: string
  tags: string[]
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
  interactionStates: Record<string, string>
  reservedStates: Record<string, string[]>
  emotePool: EmotePoolEntry[]
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
  if (value === undefined) return { fallback: '', emotions: {} }
  const source = value as Record<string, unknown>
  return {
    fallback: mergeOptionalString(source.fallback, `${label}.fallback`),
    emotions: mergeStringArrayMap(source.emotions, `${label}.emotions`),
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

function mergeManifest(raw: unknown): CharacterManifest {
  const source = (raw ?? {}) as Record<string, unknown>
  const portraits = (source.portraits ?? {}) as Record<string, unknown>
  const emotionVocabulary = mergeOptionalStringArray(source.emotionVocabulary, 'emotionVocabulary')

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
    interactionStates: mergeStringMap(source.interactionStates, 'interactionStates'),
    reservedStates: mergeStringArrayMap(source.reservedStates, 'reservedStates'),
    emotePool: mergeEmotePool(source.emotePool),
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

  const manifest = mergeManifest(raw)
  logAssetProblems(validateManifestAssets(characterId, raw, path.join(CHARACTERS_ROOT, characterId)))
  return manifest
}
