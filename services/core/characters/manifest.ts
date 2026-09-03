import fs from 'fs'
import path from 'path'
import * as dotenv from 'dotenv'

// 本模块在读 ASSET_PATH 之前自己调用一次 dotenv.config()——与 services/core/db/index.ts
// 读 DB_PATH 前自己调用 dotenv.config() 同一做法，保证 .env 里的 ASSET_PATH 生效不依赖
// "这个模块凑巧在 db/index.ts 之后被 import"这种隐式顺序；dotenv.config() 内部本身是幂等的
// （重复调用不会覆盖已经存在的 process.env 值），跟其它模块各自调用不会互相冲突
dotenv.config()

// ASSET_PATH：角色包等静态资源根目录，配置外置（见 docs/MintBot_TDD.md §3.5「配置外置原则」）。
// 与 services/core/db/index.ts 的 DB_PATH 同一约定：读 env，缺省回退到项目内相对路径。
// 就近声明在这个模块（角色包资源的主要消费方），index.ts 的 @fastify/static 注册与本模块的
// manifest 加载共用同一份根路径，避免两处各自硬编码、以后改配置漏改一处。
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

// manifest schema v2（docs/MintBot_TDD.md §3.7「立绘资源管理（manifest schema v2）」）。
// 除 avatar 外全部字段可选——旧版角色包（Mint/example）只声明 avatar 一个字段，加载后
// 必须继续被当成合法输入，其余字段读到安全默认值。
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

// 字段整体缺失是合法情况（v2 字段除 avatar 外全部可选，旧版角色包本就没有），不告警、
// 直接回退默认值；字段存在但类型不对才是真正的手工维护失误，告警 + 回退，不连累其它字段
// ——与 config/index.ts 的 mergeNumberField/mergeMemoryConfig 同一按字段合并策略。

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

// avatar 是 v2 里唯一的必填字段（旧版角色包也一定声明它），缺失或类型错误都视为
// 手工维护失误，与其它可选字段的"缺失即合法"语义不同，因此始终告警
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

// interactionStates 的形状：Record<string, string>，单值不参与随机变体
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

// portraits.*.emotions 与 reservedStates 共同的形状：Record<string, string[]>，
// 每个标签映射到一个数组供渲染层随机挑选变体（见 TDD §3.7）
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
    emotionVocabulary: mergeOptionalStringArray(source.emotionVocabulary, 'emotionVocabulary'),
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

// 角色包 manifest 加载：文件缺失或 JSON 解析失败即为「角色包不可用」，返回 null——
// 这是 services/core/session/index.ts 里 loadSession() TODO 原定的语义（Stage 2 接入时
// 由调用方决定不可用时的降级行为，本模块只负责给出干净的失败信号，不在此处臆测降级策略）。
// 字段级别的缺失/类型错误不算「不可用」，走 mergeManifest 的按字段默认值，不拒绝整份文件。
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
