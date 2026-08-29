import type { PresetDisplayConfig } from '../../../shared/types/index.js'

// Presets.displayConfig 的默认值与读时合并解析，见 docs/MintBot_TDD.md §3.2.2
// 「Presets.displayConfig（每角色显示设置）」。默认值必须与 src/styles/global.css 的
// --chat-bg-rgb / --chat-bg-opacity 硬编码值完全一致，保证没自定义过的角色显示效果不变。
export const DEFAULT_DISPLAY_CONFIG: PresetDisplayConfig = {
  chatBgRgb: [15, 15, 20],
  chatBgOpacity: 0.65,
}

// 导出给 routes/presets.ts 的 PATCH 路由做入参严格校验复用——两边共享同一份"什么值算合法"
// 的判断，避免各自维护一份、以后改校验范围时漏改一处
export function isValidChatBgRgb(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(channel => typeof channel === 'number' && Number.isInteger(channel) && channel >= 0 && channel <= 255)
  )
}

export function isValidChatBgOpacity(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1
}

// 按字段合并策略，与 config/index.ts 的 mergeNumberField/mergeMemoryConfig 一致：一个字段
// 缺失/类型错误/超出范围只回退该字段自己的默认值并告警，不连累其它已经写对的字段
function mergeDisplayConfig(source: unknown): PresetDisplayConfig {
  const chatBgRgb = (source as Record<string, unknown> | undefined)?.chatBgRgb
  const chatBgOpacity = (source as Record<string, unknown> | undefined)?.chatBgOpacity

  if (!isValidChatBgRgb(chatBgRgb)) {
    console.warn(`[DisplayConfig] chatBgRgb 缺失或类型错误，使用默认值 ${JSON.stringify(DEFAULT_DISPLAY_CONFIG.chatBgRgb)}`)
  }
  if (!isValidChatBgOpacity(chatBgOpacity)) {
    console.warn(`[DisplayConfig] chatBgOpacity 缺失或类型错误，使用默认值 ${DEFAULT_DISPLAY_CONFIG.chatBgOpacity}`)
  }

  return {
    chatBgRgb: isValidChatBgRgb(chatBgRgb) ? chatBgRgb : DEFAULT_DISPLAY_CONFIG.chatBgRgb,
    chatBgOpacity: isValidChatBgOpacity(chatBgOpacity) ? chatBgOpacity : DEFAULT_DISPLAY_CONFIG.chatBgOpacity,
  }
}

// raw 为 null（列迁移前的旧行，或从未写过的行）等价于空对象，直接取全部默认值且不告警——
// 这是正常情况不是错误；JSON 解析失败取全部默认值并告警，逐字段校验交给 mergeDisplayConfig
export function parseDisplayConfig(raw: string | null): PresetDisplayConfig {
  if (raw === null) return { ...DEFAULT_DISPLAY_CONFIG }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.warn('[DisplayConfig] displayConfig JSON 解析失败，使用默认值:', err)
    return { ...DEFAULT_DISPLAY_CONFIG }
  }

  return mergeDisplayConfig(parsed)
}
