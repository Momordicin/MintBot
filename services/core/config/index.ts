import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import chokidar from 'chokidar'
import type { ModelConfig } from '../../../shared/types/index.js'

// 独立 config 模块（TDD Phase 2 checklist）：集中承载 config.json 里"有真实消费者"的字段，
// 取代此前分散在各文件里的硬编码常量（buildContext.ts / orchestrator.ts / summarizer.ts）
// 以及 index.ts 内联的 loadConfig/watchConfig。security.encryptSensitiveFields 是部署驱动的
// 独立开关（见 config/security.ts），不在本模块范围内。voice/scheduler/overlay/streaming
// 目前没有消费者，同样不在本模块类型范围内——避免为未使用的字段做投机性建模。defaultPresetId
// 曾经也在这一批里（只被 index.ts 启动时读一次，从未有过写入通道），现在有了真正的消费者：
// 记住重启前激活的 preset（services/core/session/index.ts 的 switchPreset 写入，
// services/core/index.ts 启动时读取），因此纳入本模块。

export interface SummaryTriggerConfig {
  pendingCountThreshold: number
  oldestPendingAgeMinutes: number
  messageCountThreshold: number
  lockScreenMinutes: number
  minMessagesForLockTrigger: number
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

// 桌面呈现配置。chatPinMode 与 petAvoidanceEnabled 是两个正交维度，各自只管一个窗口：
//   chatPinMode         只管聊天窗口：'always' 始终置顶 / 'smart' 按 blocker 自动让路 /
//                       'off' 普通窗口。悬浮窗不读这个字段。
//   petAvoidanceEnabled 只管桌宠是否智能避让。
//   appRules            每个应用一条规则，exeName 存文件名（如 "chrome.exe"），不含路径。
//                       'allow' 不产生任何 blocker（即使它此刻确实全屏）；'soft' 桌宠贴边、
//                       聊天窗取消置顶；'hard' 桌宠隐藏、聊天窗 suppress。
export type ChatPinMode = 'always' | 'smart' | 'off'
export type AppRuleEffect = 'allow' | 'soft' | 'hard'

export interface AppRule {
  exeName: string
  effect: AppRuleEffect
}

export interface WindowBehaviorConfig {
  chatPinMode: ChatPinMode
  petAvoidanceEnabled: boolean
  appRules: AppRule[]
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
    minMessagesForLockTrigger: 4,
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

// 必须与 electron/main/windowBehavior.ts 的 DEFAULT_CONFIG 一致：主进程在拿到这份配置之前
// 用它自己那份默认值兜底，两边不一致会让"配置还没拉到"与"配置拉到了"表现出不同的行为
const DEFAULT_WINDOW_BEHAVIOR_CONFIG: WindowBehaviorConfig = {
  chatPinMode: 'off',
  petAvoidanceEnabled: true,
  appRules: [],
}

export const VALID_CHAT_PIN_MODES: readonly ChatPinMode[] = ['always', 'smart', 'off']
export const VALID_APP_RULE_EFFECTS: readonly AppRuleEffect[] = ['allow', 'soft', 'hard']

let currentMemoryConfig: MemoryConfig = DEFAULT_MEMORY_CONFIG
let currentModelProviderConfig: ModelConfig | undefined
let currentBackgroundModelProviderConfig: ModelConfig | undefined
let currentWindowBehaviorConfig: WindowBehaviorConfig = DEFAULT_WINDOW_BEHAVIOR_CONFIG
let currentDefaultPresetId: string | undefined
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
      minMessagesForLockTrigger: mergeNumberField(summaryTrigger, 'minMessagesForLockTrigger', DEFAULT_MEMORY_CONFIG.summaryTrigger.minMessagesForLockTrigger, 'memory.summaryTrigger.minMessagesForLockTrigger'),
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

// 字符串数组字段的合并：非数组直接回退到空数组；数组内非字符串元素被过滤掉，不让一个
// 写错类型的元素连累其它元素——跟 mergeNumberField"按字段回退，不是整体回退"同一个口径
function mergeStringArrayField(source: unknown, field: string, label: string): string[] {
  const value = (source as Record<string, unknown> | undefined)?.[field]
  if (!Array.isArray(value)) return []
  const filtered = value.filter((item): item is string => typeof item === 'string')
  if (filtered.length !== value.length) {
    console.warn(`[Config] ${label} 存在非字符串元素，已过滤`)
  }
  return filtered
}

// 旧形状（pinMode + fullscreenWhitelist + blacklist）→ 新形状的读取期兼容。旧 pinMode 只映射
// chatPinMode，不顺带推导 petAvoidanceEnabled——没有旧字段与后者对应，一律取默认值。
// 用户下一次改动任何字段时 updateWindowBehaviorConfig 会把新形状整段写回磁盘，旧字段自然退场
const LEGACY_PIN_MODE_TO_CHAT_PIN_MODE: Record<string, ChatPinMode> = {
  'always-on-top': 'always',
  'dodge-fullscreen': 'smart',
  off: 'off',
}

// 旧白名单/黑名单 → appRules。白名单语义"这些程序全屏时悬浮窗仍显示在最上层"即新的
// 'allow'（不产生任何 blocker）；黑名单语义"这些程序即使不全屏，悬浮窗也不会盖在它上面"即
// 新的 'hard'。同一个 exe 曾经可以同时出现在两份名单里（旧形状允许这种自相矛盾的配置），
// 这里让先写入的 allow 胜出——Map 的 set 顺序保证 blacklist 不会覆盖已存在的同名 allow。
function migrateLegacyAppRules(windowBehavior: unknown): AppRule[] {
  const whitelist = mergeStringArrayField(windowBehavior, 'fullscreenWhitelist', 'windowBehavior.fullscreenWhitelist')
  const blacklist = mergeStringArrayField(windowBehavior, 'blacklist', 'windowBehavior.blacklist')
  const byExeName = new Map<string, AppRule>()
  for (const exeName of whitelist) byExeName.set(exeName.toLowerCase(), { exeName, effect: 'allow' })
  for (const exeName of blacklist) {
    if (byExeName.has(exeName.toLowerCase())) continue
    byExeName.set(exeName.toLowerCase(), { exeName, effect: 'hard' })
  }
  return [...byExeName.values()]
}

// 逐条校验 appRules：非法条目被单独丢弃，不连累其它条目——跟 mergeNumberField/
// mergeStringArrayField"按字段回退，不是整体回退"同一个口径。按 exeName 大小写不敏感去重
// （Windows 文件名本身不区分大小写），重复时保留先出现的一条
function mergeAppRules(windowBehavior: unknown): AppRule[] {
  const value = (windowBehavior as Record<string, unknown> | undefined)?.appRules
  if (!Array.isArray(value)) return migrateLegacyAppRules(windowBehavior)

  const byExeName = new Map<string, AppRule>()
  let dropped = 0
  for (const item of value) {
    const rule = item as Record<string, unknown> | null
    const exeName = rule?.exeName
    const effect = rule?.effect
    if (typeof exeName !== 'string' || exeName === '' || typeof effect !== 'string' || !VALID_APP_RULE_EFFECTS.includes(effect as AppRuleEffect)) {
      dropped += 1
      continue
    }
    const key = exeName.toLowerCase()
    if (byExeName.has(key)) continue
    byExeName.set(key, { exeName, effect: effect as AppRuleEffect })
  }
  if (dropped > 0) {
    console.warn(`[Config] windowBehavior.appRules 存在 ${dropped} 条不合法规则，已丢弃`)
  }
  return [...byExeName.values()]
}

function mergeWindowBehaviorConfig(raw: unknown): WindowBehaviorConfig {
  const windowBehavior = (raw as Record<string, unknown> | undefined)?.windowBehavior
  const section = windowBehavior as Record<string, unknown> | undefined

  const chatPinModeValue = section?.chatPinMode
  let chatPinMode: ChatPinMode
  if (typeof chatPinModeValue === 'string' && VALID_CHAT_PIN_MODES.includes(chatPinModeValue as ChatPinMode)) {
    chatPinMode = chatPinModeValue as ChatPinMode
  } else {
    // 缺失时先看旧 pinMode（见 LEGACY_PIN_MODE_TO_CHAT_PIN_MODE），旧字段也没有/不合法才
    // 退到默认值。只有"两个字段都没能给出答案"时才 warn——旧配置被正常识别不是异常情况
    const legacy = typeof section?.pinMode === 'string' ? LEGACY_PIN_MODE_TO_CHAT_PIN_MODE[section.pinMode] : undefined
    if (legacy !== undefined) {
      chatPinMode = legacy
    } else {
      console.warn(`[Config] windowBehavior.chatPinMode 缺失或不合法，使用默认值 '${DEFAULT_WINDOW_BEHAVIOR_CONFIG.chatPinMode}'`)
      chatPinMode = DEFAULT_WINDOW_BEHAVIOR_CONFIG.chatPinMode
    }
  }

  const petAvoidanceValue = section?.petAvoidanceEnabled
  const petAvoidanceEnabled =
    typeof petAvoidanceValue === 'boolean' ? petAvoidanceValue : DEFAULT_WINDOW_BEHAVIOR_CONFIG.petAvoidanceEnabled

  return { chatPinMode, petAvoidanceEnabled, appRules: mergeAppRules(windowBehavior) }
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
      currentWindowBehaviorConfig = mergeWindowBehaviorConfig(undefined)
      currentDefaultPresetId = undefined
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

  currentWindowBehaviorConfig = mergeWindowBehaviorConfig(raw)

  // defaultPresetId 是可选字段（首次启动时磁盘上还没有这个 key，是正常情况），不 warn；
  // 类型错误则视为未设置，交给 session/index.ts 的 resolveStartupPresetId 走首次启动同一条
  // 回退路径，而不是在这里报错阻塞启动
  const defaultPresetIdRaw = (raw as Record<string, unknown>)?.defaultPresetId
  currentDefaultPresetId = typeof defaultPresetIdRaw === 'string' ? defaultPresetIdRaw : undefined

  loaded = true
  return true
}

function ensureLoaded(): void {
  if (!loaded) load()
}

// 加载一次（同步，返回前完成）后再启动 chokidar 监听；onReload 只在文件变化触发的
// 重新加载真正成功（config.json 本身读取+解析成功，不管字段级别是否有回退）之后才调用，
// 供调用方（index.ts）在 modelProvider 等派生状态需要跟着重建时挂钩。
// 用 ensureLoaded() 而不是无条件 load()：调用方（index.ts）在这之前已经调过
// getModelProviderConfig() 触发过一次真正的加载，这里如果无条件再 load() 一次，
// 会把 config.json 重新解析一遍、把同一批字段级警告日志重复打印一遍——ensureLoaded()
// 只在真的还没加载过时才去读文件，语义（"设置监听前配置一定已加载"）不变
export function startConfigWatcher(onReload?: () => void): void {
  ensureLoaded()
  chokidar.watch(CONFIG_PATH).on('change', () => {
    console.log('[Config] Reloading config.json...')
    if (load()) onReload?.()
  })
}

export function getMemoryConfig(): MemoryConfig {
  ensureLoaded()
  return currentMemoryConfig
}

export function getWindowBehaviorConfig(): WindowBehaviorConfig {
  ensureLoaded()
  return currentWindowBehaviorConfig
}

// 重启后恢复上次激活 preset 用（services/core/index.ts 启动时读取）；未设置过时返回
// undefined，调用方（session/index.ts 的 resolveStartupPresetId）负责首次启动的回退
export function getDefaultPresetId(): string | undefined {
  ensureLoaded()
  return currentDefaultPresetId
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

// windowBehavior 不是可选字段（不像 backgroundModelProvider 那样支持整体清除），
// value 的 null 分支只在 writeConfigSection 里为 modelProvider/backgroundModelProvider 服务
function readRawSection(section: 'modelProvider' | 'backgroundModelProvider' | 'windowBehavior'): Record<string, unknown> {
  const value = readRawConfig()[section]
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

// 只替换目标 section，其余顶层字段（memory 等）原样保留；用与壁纸上传路由
// （services/core/routes/presets.ts）相同的"临时文件 + 同目录 rename"原子写模式，
// 不直接 writeFileSync 到 CONFIG_PATH。value 为 null 时把该 key 从写出的 JSON 里整个删掉
// （而不是写入 JSON null），与 load() 里"该字段类型不是 object 就视为未配置"的判断逻辑
// 保持一致，保证下次 reload 时被当成"未配置"。defaultPresetId 是纯字符串顶层字段
// （不像其它 section 是嵌套对象），value 直接原样赋给 raw[section] 同样成立
// section 名与它允许的 value 类型的对应表。不用裸联合（'a'|'b' + A|B|null）——那样
// 两个参数互相脱钩，writeConfigSection('modelProvider', someString) 也能编译过
type ConfigSectionValue = {
  modelProvider: ModelConfig
  backgroundModelProvider: ModelConfig
  windowBehavior: WindowBehaviorConfig
  defaultPresetId: string
}

function writeConfigSection<K extends keyof ConfigSectionValue>(
  section: K,
  value: ConfigSectionValue[K] | null
): void {
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

// 悬浮窗行为策略写入：partial 已经在路由层校验过（pinMode 合法值、数组元素为字符串），
// 这里只负责合并 + 落盘，同上两个 update* 函数一样立即同步内存态，不等 chokidar 的异步 reload。
// 合并起点必须用 getWindowBehaviorConfig()（已经过 mergeWindowBehaviorConfig 补齐默认值的
// 当前配置），不能像 updateModelProviderConfig 那样直接用 readRawSection('windowBehavior')——
// modelProvider 没有字段级默认值合并逻辑，磁盘原始内容本身就是权威态；但 windowBehavior 的
// 读取路径会给 chatPinMode/petAvoidanceEnabled/appRules 各自补默认值（并顺带读旧形状，见
// mergeWindowBehaviorConfig），磁盘上的 section 可能残缺（手改，或仍然是旧形状）。若合并
// 起点用 readRawSection，残缺字段会直接从 merged 里消失，被写回磁盘、同步进
// currentWindowBehaviorConfig，再经 broadcastEvent 发给主进程——而主进程
// （electron/main/windowBehavior.ts）整份替换缓存后会拿着 undefined 的 appRules 去
// find(...)，在 500ms 前台轮询里持续抛 uncaughtException
export function updateWindowBehaviorConfig(partial: Partial<WindowBehaviorConfig>): WindowBehaviorConfig {
  const merged = { ...getWindowBehaviorConfig(), ...partial } as WindowBehaviorConfig
  // 后端兜底去重：渲染层的"添加"流程虽然已经检查过同名规则，但这是并发写入下唯一真正权威的
  // 一道关卡——写入的数组里如果混进同名规则，React 列表按 exeName 当 key 会撞车，删除操作也
  // 会一次性把重复项全部删掉而不是删单条。大小写不敏感，与 mergeAppRules 同一个理由
  if (Array.isArray(merged.appRules)) {
    const byExeName = new Map<string, AppRule>()
    for (const rule of merged.appRules) {
      if (!byExeName.has(rule.exeName.toLowerCase())) byExeName.set(rule.exeName.toLowerCase(), rule)
    }
    merged.appRules = [...byExeName.values()]
  }
  writeConfigSection('windowBehavior', merged)
  currentWindowBehaviorConfig = merged
  loaded = true
  return merged
}

// 当前激活 preset 写入：由 session/index.ts 的 switchPreset 在切换成功后调用，不在进程
// 退出时才写——退出路径（尤其 Windows 上）不可靠，切换发生的当下才是唯一保证会执行到的时机。
// 与其它 update* 函数一样立即同步内存态，不等 chokidar 的异步 reload
export function setDefaultPresetId(presetId: string): void {
  writeConfigSection('defaultPresetId', presetId)
  currentDefaultPresetId = presetId
  loaded = true
}
