import type { PresetDisplayConfig } from '../../../shared/types/index.js'

export const DEFAULT_DISPLAY_CONFIG: PresetDisplayConfig = {
  chatBgRgb: [15, 15, 20],
  chatBgOpacity: 0.65,
  themeMode: 'auto',
  accentRgb: [0, 122, 255],
  tintStrength: 0,
  currentPortrait: 'pixel',
}

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

export function isValidAccentRgb(value: unknown): value is [number, number, number] {
  return isValidChatBgRgb(value)
}

export function isValidThemeMode(value: unknown): value is 'day' | 'night' | 'auto' {
  return value === 'day' || value === 'night' || value === 'auto'
}

export function isValidCurrentPortrait(value: unknown): value is 'pixel' | 'illustration' {
  return value === 'pixel' || value === 'illustration'
}

export function isValidTintStrength(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function clampTintStrength(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function mergeDisplayConfig(source: unknown): PresetDisplayConfig {
  const record = source as Record<string, unknown> | undefined
  const chatBgRgb = record?.chatBgRgb
  const chatBgOpacity = record?.chatBgOpacity
  const themeMode = record?.themeMode
  const accentRgb = record?.accentRgb
  const tintStrength = record?.tintStrength
  const currentPortrait = record?.currentPortrait

  if (!isValidChatBgRgb(chatBgRgb)) {
    console.warn(`[DisplayConfig] chatBgRgb 缺失或类型错误，使用默认值 ${JSON.stringify(DEFAULT_DISPLAY_CONFIG.chatBgRgb)}`)
  }
  if (!isValidChatBgOpacity(chatBgOpacity)) {
    console.warn(`[DisplayConfig] chatBgOpacity 缺失或类型错误，使用默认值 ${DEFAULT_DISPLAY_CONFIG.chatBgOpacity}`)
  }

  const resolvedChatBgRgb = isValidChatBgRgb(chatBgRgb) ? chatBgRgb : DEFAULT_DISPLAY_CONFIG.chatBgRgb

  if (themeMode !== undefined && !isValidThemeMode(themeMode)) {
    console.warn(`[DisplayConfig] themeMode 类型错误，使用默认值 ${DEFAULT_DISPLAY_CONFIG.themeMode}`)
  }
  if (accentRgb !== undefined && !isValidAccentRgb(accentRgb)) {
    console.warn(`[DisplayConfig] accentRgb 类型错误，使用默认值 ${JSON.stringify(DEFAULT_DISPLAY_CONFIG.accentRgb)}`)
  }
  if (tintStrength !== undefined && !isValidTintStrength(tintStrength)) {
    console.warn(`[DisplayConfig] tintStrength 类型错误，使用默认值 ${DEFAULT_DISPLAY_CONFIG.tintStrength}`)
  }
  if (currentPortrait !== undefined && !isValidCurrentPortrait(currentPortrait)) {
    console.warn(`[DisplayConfig] currentPortrait 类型错误，使用默认值 ${DEFAULT_DISPLAY_CONFIG.currentPortrait}`)
  }

  return {
    chatBgRgb: resolvedChatBgRgb,
    chatBgOpacity: isValidChatBgOpacity(chatBgOpacity) ? chatBgOpacity : DEFAULT_DISPLAY_CONFIG.chatBgOpacity,
    themeMode: isValidThemeMode(themeMode) ? themeMode : DEFAULT_DISPLAY_CONFIG.themeMode,
    accentRgb: isValidAccentRgb(accentRgb) ? accentRgb : DEFAULT_DISPLAY_CONFIG.accentRgb,
    tintStrength: isValidTintStrength(tintStrength) ? clampTintStrength(tintStrength) : DEFAULT_DISPLAY_CONFIG.tintStrength,
    currentPortrait: isValidCurrentPortrait(currentPortrait) ? currentPortrait : DEFAULT_DISPLAY_CONFIG.currentPortrait,
  }
}

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
