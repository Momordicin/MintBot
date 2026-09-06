// 聊天窗口 chrome 配色派生（TDD §2.2「主题配色」/「派生策略」、§3.2.2「渲染层消费」路径
// 2/3、§3.7 附「聊天窗口 chrome 模型」批次二）。纯函数模块，不依赖 DOM，供
// chromeColor.test.ts 单测覆盖；唯一的运行时依赖是 color2k 的 readableColor()（TDD 明确
// 只用它做一件事：主题色的明暗判断，供纱色方向 / 窗口按钮符号色 / 文字深浅三处复用）。
//
// 消费方：src/chat/ChatWindow.tsx（在 .chat-window 根 div 上下发 CSS 变量、经 IPC
// 'titlebar:set-overlay' 下发原生按钮条带配色）。
import { readableColor } from 'color2k'

export type RgbTuple = [number, number, number]

// 与 src/styles/global.css `:root` 里的 --chat-bg-rgb 必须保持一致。存在的理由是
// displayConfig 是可选字段（v7 之前创建的历史冻结快照没有它）：CSS 那半缺了会自然降级到
// `:root`，而经 IPC 下发的原生按钮条带没有等价降级，缺了就会停在上一个 preset 的值。
// 两边共用这一份字面默认色，才能保证「自绘标题栏」与「原生条带」任何时候都收敛到同一个答案
export const DEFAULT_CHAT_BG_RGB: RgbTuple = [15, 15, 20]

// ─── oklab ⇄ sRGB（Björn Ottosson 系数：https://bottosson.github.io/posts/oklab/）───
// TDD §2.2 明确要求混合空间是 oklab 而非 sRGB，两者结果不同（默认主题下的具体数字见
// deriveBubbleColors 的用例）。

function srgbToLinear(c: number): number {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(c: number): number {
  const clamped = Math.min(1, Math.max(0, c))
  const v = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055
  return Math.round(v * 255)
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

function oklabToRgb({ L, a, b }: Oklab): RgbTuple {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b

  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3

  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s

  return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)]
}

/** 主题色的 oklab 明度 L，用于 §2.2 三段式分档判断 */
export function oklabLightness(rgb: RgbTuple): number {
  return rgbToOklab(rgb).L
}

/** 在 oklab 空间按权重 t 混合两个 sRGB 颜色（t=0 取 from，t=1 取 to） */
export function mixOklab(from: RgbTuple, to: RgbTuple, t: number): RgbTuple {
  const a = rgbToOklab(from)
  const b = rgbToOklab(to)
  return oklabToRgb({
    L: a.L + (b.L - a.L) * t,
    a: a.a + (b.a - a.a) * t,
    b: a.b + (b.b - a.b) * t,
  })
}

function toRgbaString([r, g, b]: RgbTuple, alpha: number): string {
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function toRgbString([r, g, b]: RgbTuple): string {
  return `rgb(${r}, ${g}, ${b})`
}

// ─── §2.2 气泡三段式派生表 ──────────────────────────────────────────────
const WHITE: RgbTuple = [255, 255, 255]
const BLACK: RgbTuple = [0, 0, 0]

export const DARK_BAND_MAX_L = 0.35
export const LIGHT_BAND_MIN_L = 0.65

export const BUBBLE_BOT_ALPHA = 0.80
export const BUBBLE_USER_ALPHA = 0.65

interface BubbleMixParams {
  botTarget: RgbTuple
  botRatio: number
  userTarget: RgbTuple
  userRatio: number
}

/** §2.2 三段式表的分档 + 混合目标/比例选择，按 L 输入方便单独测试分档边界，
 * 不需要先找到"oklab L 恰好等于边界值"的 RGB */
export function bubbleMixParams(L: number): BubbleMixParams {
  if (L < DARK_BAND_MAX_L) {
    // 深色主题：bot 15% 白，user 80% 白
    return { botTarget: WHITE, botRatio: 0.15, userTarget: WHITE, userRatio: 0.80 }
  }
  if (L > LIGHT_BAND_MIN_L) {
    // 浅色主题：bot 80% 黑，user 15% 黑
    return { botTarget: BLACK, botRatio: 0.80, userTarget: BLACK, userRatio: 0.15 }
  }
  // 中间段：两个气泡分居背景两侧
  return { botTarget: BLACK, botRatio: 0.45, userTarget: WHITE, userRatio: 0.45 }
}

export interface BubbleColors {
  botBg: string
  userBg: string
}

/** 气泡底色（TDD §2.2）：按主题色 oklab 明度分三段选混合目标/比例，混合在 oklab 空间进行，
 * 固定 alpha（bot 0.80、user 0.65）转成 rgba() 字符串供 CSS 变量直接使用 */
export function deriveBubbleColors(themeRgb: RgbTuple): BubbleColors {
  const L = oklabLightness(themeRgb)
  const { botTarget, botRatio, userTarget, userRatio } = bubbleMixParams(L)
  const bot = mixOklab(themeRgb, botTarget, botRatio)
  const user = mixOklab(themeRgb, userTarget, userRatio)
  return {
    botBg: toRgbaString(bot, BUBBLE_BOT_ALPHA),
    userBg: toRgbaString(user, BUBBLE_USER_ALPHA),
  }
}

// ─── 纱色方向 / 窗口按钮符号色 / 文字深浅：同一次 readableColor() 判断复用 ───

/** 纱色方向（白纱/黑纱）：色深主题返回 '#fff'、浅色主题返回 '#000'。该值同时喂给
 * CSS 里的 color-mix 装饰派生（hover 纱/边框/滚动条 thumb）、下面的窗口按钮符号色，
 * 以及 .chat-titlebar__name 的文字颜色（TDD §2.2「纱色方向...三处复用」） */
export function deriveVeilColor(themeRgb: RgbTuple): string {
  return readableColor(toRgbString(themeRgb))
}

// ─── 承载内容的表面：标题栏底 / 输入栏底（TDD §3.2.2 渲染层消费路径 2）────────
// 这两处不做气泡式的白/黑分段混合——直接取主题色本身，固定 alpha 0.40（TDD §3.7 附
// 「chrome 不透明度 0.40」：自绘标题栏与输入栏的底色 alpha 取 0.40，与主进程
// TITLEBAR_OVERLAY_COLOR 的历史约定一致）
export const CHROME_SURFACE_ALPHA = 0.40

export function deriveChromeSurfaceColor(themeRgb: RgbTuple): string {
  return toRgbaString(themeRgb, CHROME_SURFACE_ALPHA)
}

export interface ChromeVars {
  veilColor: string
  bubbleBotBg: string
  bubbleUserBg: string
  titlebarBg: string
  inputBg: string
}

/** ChatWindow.tsx 在根 div 上下发的全部 chrome CSS 变量，一次性算好，
 * 避免渲染层自己再拼一遍色彩数学 */
export function deriveChromeVars(themeRgb: RgbTuple): ChromeVars {
  const veilColor = deriveVeilColor(themeRgb)
  const { botBg, userBg } = deriveBubbleColors(themeRgb)
  const surface = deriveChromeSurfaceColor(themeRgb)
  return {
    veilColor,
    bubbleBotBg: botBg,
    bubbleUserBg: userBg,
    titlebarBg: surface,
    inputBg: surface,
  }
}

// ─── 原生窗口按钮条带（TDD §3.2.2 渲染层消费路径 3、§3.7 附）─────────────────

export interface TitlebarOverlay {
  color: string
  symbolColor: string
}

function toHexAlpha0([r, g, b]: RgbTuple): string {
  const hex = (n: number) => n.toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}00`
}

/** 经 IPC 'titlebar:set-overlay' 下发给主进程的载荷。color 恒为 alpha=0——原生按钮
 * 条带完全透明，不贡献任何底色（TDD §3.7 附「原生按钮条带完全透明」，不是这里需要
 * "修正"的疏漏）；symbolColor 复用与纱色方向同一次 readableColor() 判断（Windows 上
 * Electron 不会自动为 symbolColor 计算与 color 的可访问对比度，见同节
 * 「symbolColor 必须自行计算」） */
export function deriveTitlebarOverlay(themeRgb: RgbTuple): TitlebarOverlay {
  return {
    color: toHexAlpha0(themeRgb),
    symbolColor: deriveVeilColor(themeRgb),
  }
}
