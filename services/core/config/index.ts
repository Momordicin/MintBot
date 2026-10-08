import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import chokidar from 'chokidar'
import type { ModelConfig } from '../../../shared/types/index.js'
import type { AppRule, AppRuleEffect, ChatPinMode, WindowBehaviorConfig } from '../../../shared/windowBehavior.js'

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

export const CONFIG_PATH = path.resolve(process.cwd(), 'config.json')

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
let windowBehaviorRevision = 1
let windowBehaviorSignature = serializeWindowBehaviorConfig(DEFAULT_WINDOW_BEHAVIOR_CONFIG)
let windowBehaviorSeeded = false
let currentDefaultPresetId: string | undefined
let loaded = false

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

function mergeStringArrayField(source: unknown, field: string, label: string): string[] {
  const value = (source as Record<string, unknown> | undefined)?.[field]
  if (!Array.isArray(value)) return []
  const filtered = value.filter((item): item is string => typeof item === 'string')
  if (filtered.length !== value.length) {
    console.warn(`[Config] ${label} 存在非字符串元素，已过滤`)
  }
  return filtered
}

const LEGACY_PIN_MODE_TO_CHAT_PIN_MODE: Record<string, ChatPinMode> = {
  'always-on-top': 'always',
  'dodge-fullscreen': 'smart',
  off: 'off',
}

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

function serializeWindowBehaviorConfig(config: WindowBehaviorConfig): string {
  return JSON.stringify([config.chatPinMode, config.petAvoidanceEnabled, config.appRules.map(rule => [rule.exeName, rule.effect])])
}

function applyWindowBehaviorConfig(next: WindowBehaviorConfig): boolean {
  const signature = serializeWindowBehaviorConfig(next)
  const changed = windowBehaviorSeeded && signature !== windowBehaviorSignature
  currentWindowBehaviorConfig = next
  windowBehaviorSignature = signature
  windowBehaviorSeeded = true
  if (changed) windowBehaviorRevision += 1
  return changed
}

interface LoadResult {
  ok: boolean
  windowBehaviorChanged: boolean
}

function load(): LoadResult {
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
      applyWindowBehaviorConfig(mergeWindowBehaviorConfig(undefined))
      currentDefaultPresetId = undefined
      loaded = true
    } else {
      console.warn('[Config] config.json 重新加载失败，保留上一次的有效配置:', err)
    }
    return { ok: false, windowBehaviorChanged: false }
  }

  currentMemoryConfig = mergeMemoryConfig(raw)

  const modelProviderRaw = (raw as Record<string, unknown>)?.modelProvider
  if (modelProviderRaw && typeof modelProviderRaw === 'object') {
    currentModelProviderConfig = modelProviderRaw as ModelConfig
  } else {
    currentModelProviderConfig = undefined
    console.warn('[Config] modelProvider 缺失或类型错误')
  }

  const backgroundModelProviderRaw = (raw as Record<string, unknown>)?.backgroundModelProvider
  currentBackgroundModelProviderConfig =
    backgroundModelProviderRaw && typeof backgroundModelProviderRaw === 'object'
      ? (backgroundModelProviderRaw as ModelConfig)
      : undefined

  const windowBehaviorChanged = applyWindowBehaviorConfig(mergeWindowBehaviorConfig(raw))

  const defaultPresetIdRaw = (raw as Record<string, unknown>)?.defaultPresetId
  currentDefaultPresetId = typeof defaultPresetIdRaw === 'string' ? defaultPresetIdRaw : undefined

  loaded = true
  return { ok: true, windowBehaviorChanged }
}

function ensureLoaded(): void {
  if (!loaded) load()
}

export function startConfigWatcher(onReload?: (result: { windowBehaviorChanged: boolean }) => void): void {
  ensureLoaded()
  chokidar.watch(CONFIG_PATH).on('change', () => {
    console.log('[Config] Reloading config.json...')
    const result = load()
    if (result.ok) onReload?.({ windowBehaviorChanged: result.windowBehaviorChanged })
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

export function getWindowBehaviorRevision(): number {
  ensureLoaded()
  return windowBehaviorRevision
}

export function getDefaultPresetId(): string | undefined {
  ensureLoaded()
  return currentDefaultPresetId
}

export function getModelProviderConfig(): ModelConfig {
  ensureLoaded()
  if (!currentModelProviderConfig) throw new Error('[Config] modelProvider is not configured')
  return currentModelProviderConfig
}

export function getBackgroundModelProviderConfig(): ModelConfig {
  ensureLoaded()
  return currentBackgroundModelProviderConfig ?? getModelProviderConfig()
}

export function getRawBackgroundModelProviderConfig(): ModelConfig | null {
  ensureLoaded()
  return currentBackgroundModelProviderConfig ?? null
}

function readRawConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

function readRawSection(section: 'modelProvider' | 'backgroundModelProvider' | 'windowBehavior'): Record<string, unknown> {
  const value = readRawConfig()[section]
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

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
    }
    throw err
  }
}

export function updateModelProviderConfig(partial: Partial<ModelConfig>): ModelConfig {
  const merged = { ...readRawSection('modelProvider'), ...partial } as ModelConfig
  writeConfigSection('modelProvider', merged)
  currentModelProviderConfig = merged
  loaded = true
  return merged
}

export function updateBackgroundModelProviderConfig(partial: Partial<ModelConfig> | null): ModelConfig | null {
  const merged = partial === null ? null : ({ ...readRawSection('backgroundModelProvider'), ...partial } as ModelConfig)
  writeConfigSection('backgroundModelProvider', merged)
  currentBackgroundModelProviderConfig = merged ?? undefined
  loaded = true
  return merged
}

export function updateWindowBehaviorConfig(partial: Partial<WindowBehaviorConfig>): WindowBehaviorConfig {
  const merged = { ...getWindowBehaviorConfig(), ...partial } as WindowBehaviorConfig
  if (Array.isArray(merged.appRules)) {
    const byExeName = new Map<string, AppRule>()
    for (const rule of merged.appRules) {
      if (!byExeName.has(rule.exeName.toLowerCase())) byExeName.set(rule.exeName.toLowerCase(), rule)
    }
    merged.appRules = [...byExeName.values()]
  }
  writeConfigSection('windowBehavior', merged)
  applyWindowBehaviorConfig(merged)
  loaded = true
  return merged
}

export function setDefaultPresetId(presetId: string): void {
  writeConfigSection('defaultPresetId', presetId)
  currentDefaultPresetId = presetId
  loaded = true
}
