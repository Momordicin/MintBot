// src/chat/themeVars.ts — 把 ThemeColors 转为界面用的 CSS 自定义属性，并提供默认主题输入、日夜模式解析与 Windows 标题栏覆盖色
// 用法：themeCssVars(theme, chatBgOpacity) 的结果由 ChatWindow / SettingsApp 写到 document.documentElement.style，CharacterPanel 写到预览容器；resolveThemeMode 解析 auto；titlebarOverlayFromTheme 的结果由 ChatWindow 传给 electronAPI.setTitlebarOverlay
// 对应文件：src/chat/theme.ts / src/chat/themeVars.test.ts / src/chat/chat.css / src/settings/settings.css / src/chat/ChatWindow.tsx / src/settings/SettingsApp.tsx / src/settings/CharacterPanel.tsx
import type { AlphaColor, RgbTuple, ThemeColors, ThemeInput, ThemeMode } from './theme.js'

export const DEFAULT_THEME_INPUT: ThemeInput = {
  accentRgb: [0, 122, 255],
  mode: 'night',
  tintStrength: 0,
}

export const DEFAULT_CHAT_BG_OPACITY = 0.65

export function resolveThemeMode(configuredMode: 'day' | 'night' | 'auto', prefersDark: boolean): ThemeMode {
  return configuredMode === 'auto' ? (prefersDark ? 'night' : 'day') : configuredMode
}

function rgbTriplet([r, g, b]: RgbTuple): string {
  return `${r}, ${g}, ${b}`
}

function rgbString(rgb: RgbTuple): string {
  return `rgb(${rgbTriplet(rgb)})`
}

function alphaColorToRgba({ base, alpha }: AlphaColor): string {
  const [r, g, b] = base
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function boostAlpha({ base, alpha }: AlphaColor, boost: number): AlphaColor {
  return { base, alpha: Math.min(1, alpha + boost) }
}

const SCROLLBAR_THUMB_HOVER_ALPHA_BOOST = 0.15

export const CHROME_MATERIAL_ALPHA = 0.65

export interface ThemeCssVars {
  '--window-bg-rgb': string
  '--bg2-rgb': string
  '--chat-bg-opacity': string
  '--bubble-bot-bg': string
  '--bubble-user-bg': string
  '--bubble-bot-text': string
  '--bubble-user-text': string
  '--titlebar-bg': string
  '--input-bg': string
  '--titlebar-text': string
  '--input-text': string
  '--input-placeholder': string
  '--input-border': string
  '--text-secondary': string
  '--system-msg-text': string
  '--scrollbar-thumb': string
  '--scrollbar-thumb-hover': string
  '--label': string
  '--label2': string
  '--label3': string
  '--label4': string
  '--fill1': string
  '--fill2': string
  '--fill3': string
  '--accent': string
  '--accent-rgb': string
  '--error': string
  '--on-error': string
  '--error-container': string
  '--on-error-container': string
}

export function themeCssVars(theme: ThemeColors, chatBgOpacity: number): ThemeCssVars {
  const chromeMaterialRgba = alphaColorToRgba({ base: theme.bg2, alpha: CHROME_MATERIAL_ALPHA })

  return {
    '--window-bg-rgb': rgbTriplet(theme.bg),
    '--bg2-rgb': rgbTriplet(theme.bg2),
    '--chat-bg-opacity': String(chatBgOpacity),
    '--bubble-bot-bg': rgbString(theme.bubbleIn),
    '--bubble-user-bg': rgbString(theme.bubbleOut),
    '--bubble-bot-text': rgbString(theme.label.base),
    '--bubble-user-text': rgbString(theme.labelOnAccent),
    '--titlebar-bg': chromeMaterialRgba,
    '--input-bg': chromeMaterialRgba,
    '--titlebar-text': rgbString(theme.label.base),
    '--input-text': rgbString(theme.label.base),
    '--input-placeholder': alphaColorToRgba(theme.label3),
    '--input-border': alphaColorToRgba(theme.separator),
    '--text-secondary': alphaColorToRgba(theme.label2),
    '--system-msg-text': alphaColorToRgba(theme.label2),
    '--scrollbar-thumb': alphaColorToRgba(theme.fill1),
    '--scrollbar-thumb-hover': alphaColorToRgba(boostAlpha(theme.fill1, SCROLLBAR_THUMB_HOVER_ALPHA_BOOST)),
    '--label': rgbString(theme.label.base),
    '--label2': alphaColorToRgba(theme.label2),
    '--label3': alphaColorToRgba(theme.label3),
    '--label4': alphaColorToRgba(theme.label4),
    '--fill1': alphaColorToRgba(theme.fill1),
    '--fill2': alphaColorToRgba(theme.fill2),
    '--fill3': alphaColorToRgba(theme.fill3),
    '--accent': rgbString(theme.bubbleOut),
    '--accent-rgb': rgbTriplet(theme.bubbleOut),
    '--error': rgbString(theme.error),
    '--on-error': rgbString(theme.onError),
    '--error-container': rgbString(theme.errorContainer),
    '--on-error-container': rgbString(theme.onErrorContainer),
  }
}

export interface TitlebarOverlay {
  color: string
  symbolColor: string
}

function toHex([r, g, b]: RgbTuple): string {
  const hex = (n: number) => n.toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

export function titlebarOverlayFromTheme(theme: ThemeColors): TitlebarOverlay {
  return {
    color: `${toHex(theme.bg)}00`,
    symbolColor: toHex(theme.label.base),
  }
}
