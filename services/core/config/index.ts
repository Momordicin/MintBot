import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import chokidar from 'chokidar'
import type { ModelConfig } from '../../../shared/types/index.js'

// 独立 config 模块（TDD Phase 2 checklist）：集中承载 config.json 里"有真实消费者"的字段，
// 取代此前分散在各文件里的硬编码常量（buildContext.ts / orchestrator.ts / summarizer.ts）
// 以及 index.ts 内联的 loadConfig/watchConfig。security.encryptSensitiveFields 是部署驱动的
// 独立开关（见 config/security.ts），不在本模块范围内。voice/scheduler/overlay/defaultPresetId/
// streaming 目前没有消费者，同样不在本模块类型范围内——避免为未使用的字段做投机性建模。

export interface SummaryTriggerConfig {
  pendingCountThreshold: number
  oldestPendingAgeMinutes: number
  messageCountThreshold: number
  lockScreenMinutes: number
}

export interface ContextBudgetConfig {
  total: number
  systemPrompt: number
  summary: number
  rag: number
  recentMessages: number
  responseReserve: number
}

export interface MemoryConfig {
  recentTrackMaxMessages: number
  recentTrackMaxMinutes: number
  organizeWindowStartHour: number
  organizeWindowEndHour: number
  summaryTrigger: SummaryTriggerConfig
  contextBudget: ContextBudgetConfig
}

export const CONFIG_PATH = path.resolve(process.cwd(), 'config.json')

// 默认值必须与迁移前各文件硬编码的常量完全一致，保证没有 config.json（或字段缺失）的用户
// 行为不发生变化
const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  recentTrackMaxMessages: 50,
  recentTrackMaxMinutes: 30,
  organizeWindowStartHour: 22,
  organizeWindowEndHour: 8,
  summaryTrigger: {
    pendingCountThreshold: 100,
    oldestPendingAgeMinutes: 120,
    messageCountThreshold: 50,
    lockScreenMinutes: 60,
  },
  contextBudget: {
    total: 8000,
    systemPrompt: 1000,
    summary: 1500,
    rag: 2000,
    recentMessages: 3000,
    responseReserve: 500,
  },
}

let currentMemoryConfig: MemoryConfig = DEFAULT_MEMORY_CONFIG
let currentModelProviderConfig: ModelConfig | undefined
let currentBackgroundModelProviderConfig: ModelConfig | undefined
let loaded = false

// 单个数字字段的按字段合并：存在且类型正确则使用，否则告警 + 回退到该字段自己的默认值
// （不是整份 config.json 校验失败就整体回退——一个字段写错不该连累其它已经写对的字段）
function mergeNumberField(source: unknown, field: string, fallback: number, label: string): number {
  const value = (source as Record<string, unknown> | undefined)?.[field]
  if (typeof value === 'number') return value
  console.warn(`[Config] ${label} 缺失或类型错误，使用默认值 ${fallback}`)
  return fallback
}

function mergeMemoryConfig(raw: unknown): MemoryConfig {
  const memory = (raw as Record<string, unknown> | undefined)?.memory
  const summaryTrigger = (memory as Record<string, unknown> | undefined)?.summaryTrigger
  const contextBudget = (memory as Record<string, unknown> | undefined)?.contextBudget

  return {
    recentTrackMaxMessages: mergeNumberField(memory, 'recentTrackMaxMessages', DEFAULT_MEMORY_CONFIG.recentTrackMaxMessages, 'memory.recentTrackMaxMessages'),
    recentTrackMaxMinutes: mergeNumberField(memory, 'recentTrackMaxMinutes', DEFAULT_MEMORY_CONFIG.recentTrackMaxMinutes, 'memory.recentTrackMaxMinutes'),
    organizeWindowStartHour: mergeNumberField(memory, 'organizeWindowStartHour', DEFAULT_MEMORY_CONFIG.organizeWindowStartHour, 'memory.organizeWindowStartHour'),
    organizeWindowEndHour: mergeNumberField(memory, 'organizeWindowEndHour', DEFAULT_MEMORY_CONFIG.organizeWindowEndHour, 'memory.organizeWindowEndHour'),
    summaryTrigger: {
      pendingCountThreshold: mergeNumberField(summaryTrigger, 'pendingCountThreshold', DEFAULT_MEMORY_CONFIG.summaryTrigger.pendingCountThreshold, 'memory.summaryTrigger.pendingCountThreshold'),
      oldestPendingAgeMinutes: mergeNumberField(summaryTrigger, 'oldestPendingAgeMinutes', DEFAULT_MEMORY_CONFIG.summaryTrigger.oldestPendingAgeMinutes, 'memory.summaryTrigger.oldestPendingAgeMinutes'),
      messageCountThreshold: mergeNumberField(summaryTrigger, 'messageCountThreshold', DEFAULT_MEMORY_CONFIG.summaryTrigger.messageCountThreshold, 'memory.summaryTrigger.messageCountThreshold'),
      lockScreenMinutes: mergeNumberField(summaryTrigger, 'lockScreenMinutes', DEFAULT_MEMORY_CONFIG.summaryTrigger.lockScreenMinutes, 'memory.summaryTrigger.lockScreenMinutes'),
    },
    contextBudget: {
      total: mergeNumberField(contextBudget, 'total', DEFAULT_MEMORY_CONFIG.contextBudget.total, 'memory.contextBudget.total'),
      systemPrompt: mergeNumberField(contextBudget, 'systemPrompt', DEFAULT_MEMORY_CONFIG.contextBudget.systemPrompt, 'memory.contextBudget.systemPrompt'),
      summary: mergeNumberField(contextBudget, 'summary', DEFAULT_MEMORY_CONFIG.contextBudget.summary, 'memory.contextBudget.summary'),
      rag: mergeNumberField(contextBudget, 'rag', DEFAULT_MEMORY_CONFIG.contextBudget.rag, 'memory.contextBudget.rag'),
      recentMessages: mergeNumberField(contextBudget, 'recentMessages', DEFAULT_MEMORY_CONFIG.contextBudget.recentMessages, 'memory.contextBudget.recentMessages'),
      responseReserve: mergeNumberField(contextBudget, 'responseReserve', DEFAULT_MEMORY_CONFIG.contextBudget.responseReserve, 'memory.contextBudget.responseReserve'),
    },
  }
}

// 加载 + 校验 + 合并一次，返回这次加载本身是否成功读到并解析了 config.json（不代表每个
// 字段都合法——字段级别的缺失/类型错误走 mergeNumberField 的按字段回退，不算加载失败）。
// config.json 整体缺失/解析失败时：首次加载回退到全部默认值；热更新期间（loaded 已为 true）
// 解析失败则保留上一次的有效配置，不让一次写入中途的临时坏文件把已经在跑的服务打回默认值
function load(): boolean {
  let raw: unknown
  try {
    const text = fs.readFileSync(CONFIG_PATH, 'utf-8')
    raw = JSON.parse(text)
  } catch (err) {
    if (!loaded) {
      console.warn('[Config] config.json 不存在或解析失败，全部字段使用默认值:', err)
      currentMemoryConfig = mergeMemoryConfig(undefined)
      currentModelProviderConfig = undefined
      currentBackgroundModelProviderConfig = undefined
      loaded = true
    } else {
      console.warn('[Config] config.json 重新加载失败，保留上一次的有效配置:', err)
    }
    return false
  }

  currentMemoryConfig = mergeMemoryConfig(raw)

  const modelProviderRaw = (raw as Record<string, unknown>)?.modelProvider
  if (modelProviderRaw && typeof modelProviderRaw === 'object') {
    currentModelProviderConfig = modelProviderRaw as ModelConfig
  } else {
    currentModelProviderConfig = undefined
    console.warn('[Config] modelProvider 缺失或类型错误')
  }

  // backgroundModelProvider 是可选字段（整理模式独立模型配置）：缺失是正常情况，不 warn，
  // getBackgroundModelProviderConfig() 会 fallback 到 modelProvider
  const backgroundModelProviderRaw = (raw as Record<string, unknown>)?.backgroundModelProvider
  currentBackgroundModelProviderConfig =
    backgroundModelProviderRaw && typeof backgroundModelProviderRaw === 'object'
      ? (backgroundModelProviderRaw as ModelConfig)
      : undefined

  loaded = true
  return true
}

function ensureLoaded(): void {
  if (!loaded) load()
}

// 加载一次（同步，返回前完成）后再启动 chokidar 监听；onReload 只在文件变化触发的
// 重新加载真正成功（config.json 本身读取+解析成功，不管字段级别是否有回退）之后才调用，
// 供调用方（index.ts）在 modelProvider 等派生状态需要跟着重建时挂钩
export function startConfigWatcher(onReload?: () => void): void {
  load()
  chokidar.watch(CONFIG_PATH).on('change', () => {
    console.log('[Config] Reloading config.json...')
    if (load()) onReload?.()
  })
}

export function getMemoryConfig(): MemoryConfig {
  ensureLoaded()
  return currentMemoryConfig
}

export function getModelProviderConfig(): ModelConfig {
  ensureLoaded()
  if (!currentModelProviderConfig) throw new Error('[Config] modelProvider is not configured')
  return currentModelProviderConfig
}

// 整理模式（摘要生成、实体抽取）的可选独立模型配置：未配置 backgroundModelProvider 时
// fallback 到 modelProvider，保证没有设置这个可选字段的用户行为与迁移前完全一致
export function getBackgroundModelProviderConfig(): ModelConfig {
  ensureLoaded()
  return currentBackgroundModelProviderConfig ?? getModelProviderConfig()
}

// backgroundModelProvider 的原始覆盖状态（fallback 之前）：GET /config/model 需要区分
// "没有配置覆盖"与"配置了覆盖且恰好等于全局配置"，getBackgroundModelProviderConfig()
// 的 fallback 语义满足不了这个需求
export function getRawBackgroundModelProviderConfig(): ModelConfig | null {
  ensureLoaded()
  return currentBackgroundModelProviderConfig ?? null
}

// ─── config.json 写入通道（设置页：全局模型配置）────────────────────────
// 读写职责放在这里，不在路由文件里直接碰文件系统，跟 queries.ts 承载 Preset 字段更新是
// 同一个分工

// 读整份 config.json 的原始内容（不经过任何字段级合并/默认值填充），供写入通道复用磁盘上
// 其它模块管的字段（memory/security 等）。文件不存在或解析失败时视为空对象——允许在
// config.json 尚不存在时通过 PATCH /config/model 首次写入
function readRawConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

function readRawSection(section: 'modelProvider' | 'backgroundModelProvider'): Partial<ModelConfig> {
  const value = readRawConfig()[section]
  return value && typeof value === 'object' ? (value as Partial<ModelConfig>) : {}
}

// 只替换目标 section，其余顶层字段（memory 等）原样保留；用与壁纸上传路由
// （services/core/routes/presets.ts）相同的"临时文件 + 同目录 rename"原子写模式，
// 不直接 writeFileSync 到 CONFIG_PATH。value 为 null 时把该 key 从写出的 JSON 里整个删掉
// （而不是写入 JSON null），与 load() 里"该字段类型不是 object 就视为未配置"的判断逻辑
// 保持一致，保证下次 reload 时被当成"未配置"
function writeConfigSection(section: 'modelProvider' | 'backgroundModelProvider', value: ModelConfig | null): void {
  const raw = readRawConfig()
  if (value === null) {
    delete raw[section]
  } else {
    raw[section] = value
  }

  const tempPath = `${CONFIG_PATH}.tmp-${crypto.randomUUID()}`
  try {
    fs.writeFileSync(tempPath, JSON.stringify(raw, null, 2))
    fs.renameSync(tempPath, CONFIG_PATH)
  } catch (err) {
    try {
      fs.rmSync(tempPath, { force: true })
    } catch {
      // 清理失败不应掩盖上面的原始错误
    }
    throw err
  }
}

// 全局对话模型配置写入：只合并 partial 到当前磁盘上的 modelProvider 之上。直接返回合并
// 后的结果给调用方（路由用这个返回值构造响应），不是等 chokidar 触发的异步 reload 后
// 再读一次 getModelProviderConfig()——避免响应内容与磁盘刚写入的内容之间出现时序竞态。
// 写入后不需要手动触发 reload：已有的 startConfigWatcher 监听同一个文件，写入本身就会
// 触发它现有的 onReload 回调
export function updateModelProviderConfig(partial: Partial<ModelConfig>): ModelConfig {
  const merged = { ...readRawSection('modelProvider'), ...partial } as ModelConfig
  writeConfigSection('modelProvider', merged)
  // 写入后立即同步更新内存态，不能只依赖 chokidar 的异步 reload：chokidar 的 'change' 事件
  // 对临时文件 rename 产生的 unlink+add 有一段去抖延迟，写入后到这段延迟结束之间，
  // getModelProviderConfig()（包括 /chat 请求实际选用哪个模型）会读到写入前的旧值。
  // chokidar 之后触发的 onReload 只是重新做一次同样的赋值，是幂等的，不会冲突——
  // chokidar 仍然是外部手改 config.json 这种被动场景唯一的感知渠道，这里只是补上
  // "通过这条写入通道自己触发的变化"不应该有的滞后
  currentModelProviderConfig = merged
  loaded = true
  return merged
}

// 摘要模型配置写入：partial 为 null 表示清除覆盖（回落到 modelProvider）
export function updateBackgroundModelProviderConfig(partial: Partial<ModelConfig> | null): ModelConfig | null {
  const merged = partial === null ? null : ({ ...readRawSection('backgroundModelProvider'), ...partial } as ModelConfig)
  writeConfigSection('backgroundModelProvider', merged)
  // 同上，立即同步更新内存态，不等 chokidar 的异步 reload
  currentBackgroundModelProviderConfig = merged ?? undefined
  loaded = true
  return merged
}
