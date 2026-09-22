import fs from 'fs'
import path from 'path'
import * as dotenv from 'dotenv'

dotenv.config({ quiet: true })

export const ASSET_ROOT = path.resolve(process.cwd(), process.env.ASSET_PATH ?? './assets')
export const CHARACTERS_ROOT = path.join(ASSET_ROOT, 'characters')

export interface PortraitForm {
  fallback: string
  emotions: Record<string, string[]>
}

export interface EmotePoolEntry {
  file: string
  tags: string[]
}

export interface TransitionStep {
  from: string[]        
  pick: 'random'
  durationMs: number
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
  transitions: Record<string, TransitionStep[]>
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

const TRANSITION_FROM_PREFIX = 'emotions.'

function normalizeTransitionFrom(value: unknown): string[] | null {
  if (typeof value === 'string') return [value]
  if (isStringArray(value) && value.length > 0) return value
  return null
}

function mergeTransitionStep(
  entry: unknown,
  emotionVocabulary: string[],
  label: string
): TransitionStep | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    console.warn(`[CharacterManifest] ${label} 类型错误，应为对象，跳过该步`)
    return null
  }
  const step = entry as Record<string, unknown>

  const from = normalizeTransitionFrom(step.from)
  if (from === null) {
    console.warn(`[CharacterManifest] ${label}.from 缺失、类型错误或为空数组，应为非空字符串数组或单个字符串，跳过该步`)
    return null
  }

  for (const source of from) {
    const key = source.startsWith(TRANSITION_FROM_PREFIX) ? source.slice(TRANSITION_FROM_PREFIX.length) : null
    if (key === null || !emotionVocabulary.includes(key)) {
      console.warn(`[CharacterManifest] ${label}.from 引用了不存在的键 '${source}'，跳过该步`)
      return null
    }
  }

  let pick: TransitionStep['pick'] = 'random'
  if (step.pick !== undefined && step.pick !== 'random') {
    console.warn(`[CharacterManifest] ${label}.pick 类型错误，应为 'random'，使用默认值 'random'`)
  }

  if (typeof step.durationMs !== 'number' || !Number.isFinite(step.durationMs) || step.durationMs <= 0) {
    console.warn(`[CharacterManifest] ${label}.durationMs 缺失或类型错误，应为正数，跳过该步`)
    return null
  }

  return { from, pick, durationMs: step.durationMs }
}

function mergeTransitions(
  value: unknown,
  emotionVocabulary: string[],
  label: string
): Record<string, TransitionStep[]> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    console.warn(`[CharacterManifest] ${label} 类型错误，应为对象，使用默认值 {}`)
    return {}
  }
  const result: Record<string, TransitionStep[]> = {}
  for (const [chainName, chainValue] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(chainValue)) {
      console.warn(`[CharacterManifest] ${label}.${chainName} 类型错误，应为数组，跳过该链`)
      continue
    }
    const steps: TransitionStep[] = []
    chainValue.forEach((entry, index) => {
      const step = mergeTransitionStep(entry, emotionVocabulary, `${label}.${chainName}[${index}]`)
      if (step) steps.push(step)
    })
    result[chainName] = steps
  }
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
    transitions: mergeTransitions(source.transitions, emotionVocabulary, 'transitions'),
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

  return mergeManifest(raw)
}
