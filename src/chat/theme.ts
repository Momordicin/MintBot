// src/chat/theme.ts — 主题配色推导：由强调色、日/夜模式与着色强度，在 OKLab 空间生成整套界面色板，并保证气泡文字对比度
// 用法：deriveTheme(input) 返回 ThemeColors；ChatWindow、SettingsApp、CharacterPanel（预览）调用后交给 themeVars.themeCssVars 转成 CSS 变量；另导出 contrastRatio、compositeOverBackground 与对比度常量
// 形状：ThemeInput { accentRgb, mode: 'day' | 'night', tintStrength(0–1) } -> ThemeColors（RGB 元组与带 alpha 的颜色）
// 对应文件：src/chat/themeVars.ts / src/chat/theme.test.ts / src/chat/ChatWindow.tsx / src/settings/SettingsApp.tsx / src/settings/CharacterPanel.tsx

export type RgbTuple = [number, number, number]
export type ThemeMode = 'day' | 'night'

export interface ThemeInput {
  accentRgb: RgbTuple
  mode: ThemeMode
  tintStrength: number
}

export interface AlphaColor {
  base: RgbTuple
  alpha: number
}

export interface ThemeColors {
  bg: RgbTuple
  bg2: RgbTuple
  bg3: RgbTuple
  bubbleIn: RgbTuple
  labelOnAccent: RgbTuple
  bubbleOut: RgbTuple
  label: AlphaColor
  label2: AlphaColor
  label3: AlphaColor
  label4: AlphaColor
  separator: AlphaColor
  separatorOpaque: RgbTuple
  fill1: AlphaColor
  fill2: AlphaColor
  fill3: AlphaColor
  error: RgbTuple
  onError: RgbTuple
  errorContainer: RgbTuple
  onErrorContainer: RgbTuple
}

function srgbToLinear(c: number): number {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function linearToSrgbUnrounded(c: number): number {
  const clamped = Math.min(1, Math.max(0, c))
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055
}

function linearToSrgb(c: number): number {
  return Math.round(linearToSrgbUnrounded(c) * 255)
}

interface Oklab {
  L: number
  a: number
  b: number
}

function rgbToOklab([r, g, b]: RgbTuple): Oklab {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb

  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(m)
  const s_ = Math.cbrt(s)

  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  }
}

function oklabToLinearRgb({ L, a, b }: Oklab): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b

  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3

  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s

  return [lr, lg, lb]
}

function oklabToRgb(lab: Oklab): RgbTuple {
  const [lr, lg, lb] = oklabToLinearRgb(lab)
  return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)]
}

function hexToRgb(hex: string): RgbTuple {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

const WHITE: RgbTuple = [255, 255, 255]

function tintRole(rgb: RgbTuple, accentLab: Oklab, tintStrength: number, k: number): RgbTuple {
  if (tintStrength <= 0 || k === 0) return rgb

  const ratio = tintStrength * k
  const lab = rgbToOklab(rgb)
  return oklabToRgb({
    L: lab.L + (accentLab.L - lab.L) * ratio,
    a: lab.a + (accentLab.a - lab.a) * ratio,
    b: lab.b + (accentLab.b - lab.b) * ratio,
  })
}

const SURFACE_TINT_K = 0.14

const LABEL_FILL_TINT_K = 0.05

export const WHITE_ON_ACCENT_MIN_CONTRAST = 4.5

export const BUBBLE_BACKGROUND_MIN_CONTRAST = 3.0

const BINARY_SEARCH_ITERATIONS = 60

function relativeLuminance([r, g, b]: RgbTuple): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

export function contrastRatio(rgbA: RgbTuple, rgbB: RgbTuple): number {
  const la = relativeLuminance(rgbA)
  const lb = relativeLuminance(rgbB)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

function clampAccentForBubble(accentRgb: RgbTuple, background: RgbTuple): RgbTuple {
  const lab = rgbToOklab(accentRgb)
  const rgbAtL = (L: number): RgbTuple => oklabToRgb({ L, a: lab.a, b: lab.b })
  const passesWhiteText = (L: number) => contrastRatio(WHITE, rgbAtL(L)) >= WHITE_ON_ACCENT_MIN_CONTRAST
  const passesBackground = (L: number) => contrastRatio(rgbAtL(L), background) >= BUBBLE_BACKGROUND_MIN_CONTRAST

  if (passesWhiteText(lab.L) && passesBackground(lab.L)) {
    return rgbAtL(lab.L)
  }

  if (!passesWhiteText(lab.L)) {
    let lo = 0
    let hi = lab.L
    for (let i = 0; i < BINARY_SEARCH_ITERATIONS; i++) {
      const mid = (lo + hi) / 2
      if (passesWhiteText(mid)) lo = mid
      else hi = mid
    }
    return rgbAtL(lo)
  }

  let lo = lab.L
  let hi = 1
  for (let i = 0; i < BINARY_SEARCH_ITERATIONS; i++) {
    const mid = (lo + hi) / 2
    if (passesBackground(mid)) hi = mid
    else lo = mid
  }
  return rgbAtL(hi)
}

export function compositeOverBackground(fg: AlphaColor, bg: RgbTuple): RgbTuple {
  const [fr, fg_, fb] = fg.base
  const [br, bgc, bb] = bg
  const a = fg.alpha
  return [
    Math.round(fr * a + br * (1 - a)),
    Math.round(fg_ * a + bgc * (1 - a)),
    Math.round(fb * a + bb * (1 - a)),
  ]
}

interface NeutralTable {
  bg: RgbTuple
  bg2: RgbTuple
  bg3: RgbTuple
  separatorOpaque: RgbTuple
  label: AlphaColor
  label2: AlphaColor
  label3: AlphaColor
  label4: AlphaColor
  separator: AlphaColor
  fill1: AlphaColor
  fill2: AlphaColor
  fill3: AlphaColor
}

const FILL_BASE: RgbTuple = hexToRgb('#787880')

const DAY_TABLE: NeutralTable = {
  bg: hexToRgb('#ffffff'),
  bg2: hexToRgb('#f2f2f7'),
  bg3: hexToRgb('#ffffff'),

  separatorOpaque: hexToRgb('#c6c6c8'),

  label: { base: hexToRgb('#000000'), alpha: 1.0 },
  label2: { base: hexToRgb('#3c3c43'), alpha: 0.60 },
  label3: { base: hexToRgb('#3c3c43'), alpha: 0.30 },
  label4: { base: hexToRgb('#3c3c43'), alpha: 0.18 },

  separator: { base: hexToRgb('#3c3c43'), alpha: 0.29 },

  fill1: { base: FILL_BASE, alpha: 0.20 },
  fill2: { base: FILL_BASE, alpha: 0.14 },
  fill3: { base: FILL_BASE, alpha: 0.08 },
}

const NIGHT_TABLE: NeutralTable = {
  bg: hexToRgb('#000000'),
  bg2: hexToRgb('#1c1c1e'),
  bg3: hexToRgb('#2c2c2e'),

  separatorOpaque: hexToRgb('#38383a'),

  label: { base: hexToRgb('#ffffff'), alpha: 1.0 },
  label2: { base: hexToRgb('#ebebf5'), alpha: 0.60 },
  label3: { base: hexToRgb('#ebebf5'), alpha: 0.30 },
  label4: { base: hexToRgb('#ebebf5'), alpha: 0.18 },

  separator: { base: hexToRgb('#545458'), alpha: 0.60 },

  fill1: { base: FILL_BASE, alpha: 0.36 },
  fill2: { base: FILL_BASE, alpha: 0.26 },
  fill3: { base: FILL_BASE, alpha: 0.16 },
}

interface ErrorPalette {
  error: RgbTuple
  onError: RgbTuple
  errorContainer: RgbTuple
  onErrorContainer: RgbTuple
}

const DAY_ERROR: ErrorPalette = {
  error: hexToRgb('#b3261e'),
  onError: hexToRgb('#ffffff'),
  errorContainer: hexToRgb('#f9dedc'),
  onErrorContainer: hexToRgb('#410e0b'),
}

const NIGHT_ERROR: ErrorPalette = {
  error: hexToRgb('#f2b8b5'),
  onError: hexToRgb('#601410'),
  errorContainer: hexToRgb('#8c1d18'),
  onErrorContainer: hexToRgb('#f9dedc'),
}

export function deriveTheme(input: ThemeInput): ThemeColors {
  const table = input.mode === 'day' ? DAY_TABLE : NIGHT_TABLE
  const errorPalette = input.mode === 'day' ? DAY_ERROR : NIGHT_ERROR
  const accentLab = rgbToOklab(input.accentRgb)
  const { tintStrength } = input

  const tintSurface = (rgb: RgbTuple) => tintRole(rgb, accentLab, tintStrength, SURFACE_TINT_K)
  const tintLabelOrFill = (rgb: RgbTuple) => tintRole(rgb, accentLab, tintStrength, LABEL_FILL_TINT_K)
  const tintAlphaSurface = (c: AlphaColor): AlphaColor => ({ base: tintSurface(c.base), alpha: c.alpha })
  const tintAlphaLabelOrFill = (c: AlphaColor): AlphaColor => ({ base: tintLabelOrFill(c.base), alpha: c.alpha })

  const bg = tintSurface(table.bg)
  const bg2 = tintSurface(table.bg2)
  const bg3 = tintSurface(table.bg3)
  const bubbleIn = input.mode === 'day' ? bg2 : bg3
  const label = tintAlphaLabelOrFill(table.label)
  const label2 = tintAlphaLabelOrFill(table.label2)
  const label3 = tintAlphaLabelOrFill(table.label3)
  const label4 = tintAlphaLabelOrFill(table.label4)
  const separator = tintAlphaSurface(table.separator)
  const separatorOpaque = tintSurface(table.separatorOpaque)
  const fill1 = tintAlphaLabelOrFill(table.fill1)
  const fill2 = tintAlphaLabelOrFill(table.fill2)
  const fill3 = tintAlphaLabelOrFill(table.fill3)
  const bubbleOut = clampAccentForBubble(input.accentRgb, table.bg)

  return {
    bg,
    bg2,
    bg3,
    bubbleIn,
    bubbleOut,
    labelOnAccent: WHITE,
    label,
    label2,
    label3,
    label4,
    separator,
    separatorOpaque,
    fill1,
    fill2,
    fill3,
    error: errorPalette.error,
    onError: errorPalette.onError,
    errorContainer: errorPalette.errorContainer,
    onErrorContainer: errorPalette.onErrorContainer,
  }
}
