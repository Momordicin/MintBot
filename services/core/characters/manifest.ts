import fs from 'fs'
import path from 'path'
import * as dotenv from 'dotenv'

// 本模块在读 ASSET_PATH 之前自己调用一次 dotenv.config()——与 services/core/db/index.ts
// 读 DB_PATH 前自己调用 dotenv.config() 同一做法，保证 .env 里的 ASSET_PATH 生效不依赖
// "这个模块凑巧在 db/index.ts 之后被 import"这种隐式顺序；dotenv.config() 内部本身是幂等的
// （重复调用不会覆盖已经存在的 process.env 值），跟其它模块各自调用不会互相冲突
dotenv.config({ quiet: true })

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

export interface TransitionStep {
  from: string[]        // 始终归一化为数组，即使 manifest 里声明的是单个字符串
  pick: 'random'
  durationMs: number
}

// manifest schema v3（docs/MintBot_TDD.md §3.7「立绘资源管理（manifest schema v3）」）。
// 除 avatar 外全部字段可选——旧版角色包（Mint/example）只声明 avatar 一个字段，加载后
// 必须继续被当成合法输入，其余字段读到安全默认值。v2 的四类资源划分（portraits/
// interactionStates/reservedStates/emotePool）不变，v3 只新增 transitions 字段。
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

// transitions 里的 from 只能引用 `emotions.<key>` 形式，且 <key> 必须存在于该角色包
// 自己声明的 emotionVocabulary（TDD「转场引用的是 emotionVocabulary 里的键」）——
// 不校验 portraits.pixel.emotions，因为解析时刻是与显示形态无关的，pixel/illustration
// 各自声明的情绪集合可以不同
const TRANSITION_FROM_PREFIX = 'emotions.'

function normalizeTransitionFrom(value: unknown): string[] | null {
  if (typeof value === 'string') return [value]
  if (isStringArray(value) && value.length > 0) return value
  return null
}

// 单步转场校验：from 类型错误、from 引用了不存在的键、durationMs 缺失或非法，
// 三者任一命中即跳过整步并告警（TDD「某一步引用了不存在的键时跳过该步并告警，
// 不使整条链失效」）。pick 走「缺失即合法回退默认值，类型错误告警回退」的既有惯例。
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

// transitions 整体形状：Record<string, TransitionStep[]>。字段整体缺失是合法情况
// （TDD「角色包未声明 transitions 时不播转场」），静默回退 {}；一条链的值不是数组时
// 跳过该链（不写入结果）；链内某一步校验失败只跳过该步，链本身继续存在，即使
// 全部步骤都被跳过也仍以空数组形式保留（等价于「无转场」）。
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
  // transitions 校验需要已合并的 emotionVocabulary（而非原始 source.emotionVocabulary），
  // 因此先算出这份词表再传给 mergeTransitions（TDD 排序说明）
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
