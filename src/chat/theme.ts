// 聊天窗口主题配色（第二代模型）：以「模式为主轴、用户只选一个 accent 色」的 Apple 结构
// 替换 chromeColor.ts 的「单一主题色三段式分档」模型（后者按 chatBgRgb 自身的 oklab
// 明度分深/中/浅三档，中性面全部由这一个颜色派生；新模型反过来——中性角色来自按模式
// 查表的 Apple 官方发布值，accent 只负责 1) 给中性角色染一点色相/彩度（tint 旋钮）、
// 2) 派生 outgoing 气泡本身）。
//
// 本文件是自包含模块：不依赖、不导出 chromeColor.ts 的任何内容，也不修改它——两个模型
// 目前并存，接入 ChatWindow.tsx / global.css 是后续阶段的工作，不在本次改动范围内。
// oklab⇄sRGB 的转换系数与 chromeColor.ts 完全一致（Björn Ottosson 系数：
// https://bottosson.github.io/posts/oklab/），在这里按同样的写法重新实现了一份
// （已用一批网格采样数据核对过两份实现逐位一致、round-trip 误差为 0）。

export type RgbTuple = [number, number, number]
export type ThemeMode = 'day' | 'night'

export interface ThemeInput {
  /** 用户选择的唯一一个 accent 色 */
  accentRgb: RgbTuple
  /** 已解析的模式；'auto' 由调用方解析成 'day'/'night' 后再传进来，这里不处理 */
  mode: ThemeMode
  /** 0..1，0 = 纯 Apple 发布值（重置按钮就是把这个设成 0） */
  tintStrength: number
}

/** 带透明度的角色：Apple 官方发布的 secondaryLabel/tertiaryLabel/quaternaryLabel/
 * separator 本来就是"底色 + 固定 alpha"定义的（要合成到具体背景上时才需要一个不透明
 * RGB），保留这个形状而不是提前合成死，让消费方自己决定要合成到 background 之上
 * 还是别的表面之上（比如气泡内的分隔线要合成到气泡底色上，不是窗口 background 上） */
export interface AlphaColor {
  base: RgbTuple
  alpha: number
}

// ─── 产出的角色集合 ──────────────────────────────────────────────────────
// 覆盖 chromeColor.ts deriveChromeVars() 现有产出 + global.css 里实际消费的完整角色
// 面，让阶段二只是把消费方指向这里算出来的值，而不必重新设计一遍需要哪些角色：
//
//   角色                  阶段二对应的旧角色（chromeColor.ts / global.css）
//   ------------------    -------------------------------------------------
//   background            --chat-bg-rgb（聊天窗口整体底色）
//   chromeSurface         deriveChromeSurfaceColor()（标题栏/输入栏底色的不透明分量；
//                         旧模型另外固定叠了 alpha 0.40 做壁纸叠色，那是 MintBot 自己
//                         的合成需求、不是 Apple 中性表的一部分，这里不代它做主，留给
//                         阶段二接线时决定——见下方"未处理事项"说明）
//   elevatedSurface       目前 chromeColor.ts 没有对应角色（标题栏和输入栏共用同一个
//                         chromeSurface）；这里仍产出 tertiarySystemBackground 对应值，
//                         给阶段二把输入框和标题栏区分开留出余地，不强制立即消费
//   bubbleIncoming        deriveBubbleColors().botBg（bot 气泡底色）
//   bubbleOutgoing        deriveBubbleColors().userBg（user 气泡底色）
//   labelPrimary          deriveVeilColor()（白纱/黑纱方向）+ 气泡/标题栏文字色；
//                         label 本来就是纯黑/纯白，同一个值天然覆盖这两处旧用途
//   labelSecondary        --text-secondary（时间戳等次要文字）
//   labelTertiary         --input-placeholder 一类更弱的文字；同时复用为 scrollbarThumb
//                         强度（中性表没有专门的 scrollbar 角色，见下方常量说明）
//   labelQuaternary       复用为 hoverVeil 强度（中性表没有专门的 hover 角色，是四级角色
//                         里最轻的一档，適合做最不打扰的叠色）
//   separator             --input-border（分隔线/边框），旧模型是 color-mix(veil 10%)
//                         就地拼出来的，这里改成 Apple 发布的 separator 角色本身
export interface ThemeColors {
  background: RgbTuple
  chromeSurface: RgbTuple
  elevatedSurface: RgbTuple
  bubbleIncoming: RgbTuple
  bubbleOutgoing: RgbTuple
  labelPrimary: RgbTuple
  labelSecondary: AlphaColor
  labelTertiary: AlphaColor
  labelQuaternary: AlphaColor
  separator: AlphaColor
}

// ─── oklab ⇄ sRGB（与 chromeColor.ts 同款系数，模块私有）──────────────────

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

/** oklab → 线性 sRGB 三通道（未裁剪、未量化到 8-bit），供色域内判断/二分使用 */
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

// 判定线性 sRGB 三通道是否落在 [0, 1] 色域内，留一点浮点误差余量
const GAMUT_EPSILON = 1e-7

function isInGamut([lr, lg, lb]: [number, number, number]): boolean {
  return (
    lr >= -GAMUT_EPSILON && lr <= 1 + GAMUT_EPSILON &&
    lg >= -GAMUT_EPSILON && lg <= 1 + GAMUT_EPSILON &&
    lb >= -GAMUT_EPSILON && lb <= 1 + GAMUT_EPSILON
  )
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

// ─── 规则 1：tint——不改变明度 ──────────────────────────────────────────
// 对每个中性角色：转到 oklab，保持 L 不变，往 a/b 上加 tintStrength * k * accent 自己
// 的 a/b。结果超出 sRGB 色域时，对这个位移量的缩放系数做二分，直到落回色域内——这样
// L 恒定不变（scaleAt() 里 L 从头到尾原样复制，从不参与二分），二分只决定 a/b 位移
// 保留几成。

// surfaces（systemBackground/secondarySystemBackground/tertiarySystemBackground/
// incoming-bubble/separator）用规格里给的 k=0.14——这些都是"底色/分隔线"一类的填充
// 角色，观感上能接受比较明显的染色
const SURFACE_TINT_K = 0.14

// label 系（label/secondaryLabel/tertiaryLabel/quaternaryLabel）用小得多的 k=0.05——
// 这几个是文字/标记角色，染色过重会让黑白文字看起来"脏"，选一个只留一点点色相暗示、
// 肉眼几乎看不出偏色但仍在数学上响应 tint 旋钮的值。两档 k 都是本次实现选的具体数值，
// 不是规格里给定的，如果之后觉得力度不对，调整这两个常量即可，不影响其余结构
const LABEL_TINT_K = 0.05

const BISECTION_ITERATIONS = 40

/** 按 tint 规则处理一个中性角色：L 不变，a/b 各加上 tintStrength*k*accent 的 a/b，
 * 超出色域则二分缩小这个位移量，直到落回色域内 */
function tintRole(rgb: RgbTuple, accentLab: Oklab, tintStrength: number, k: number): RgbTuple {
  if (tintStrength <= 0 || k === 0) return rgb

  const lab = rgbToOklab(rgb)
  const da = k * accentLab.a
  const db = k * accentLab.b
  if (da === 0 && db === 0) return rgb

  const labAt = (scale: number): Oklab => ({
    L: lab.L,
    a: lab.a + tintStrength * scale * da,
    b: lab.b + tintStrength * scale * db,
  })

  // scale=1（用户给定的完整 tintStrength）已经在色域内，直接用，不必二分
  if (isInGamut(oklabToLinearRgb(labAt(1)))) {
    return oklabToRgb(labAt(1))
  }

  // scale=0 复现原始颜色，必然在色域内；对 [0,1] 二分找最大的仍在色域内的 scale。
  // 注：day 的 systemBackground（纯白，L=1）、label（纯黑/纯白）这类落在色域顶点的
  // 角色，顶点处色域宽度为零，二分会一路收敛到 scale=0——这是预期行为，不是 bug：
  // tint 旋钮在这些角色上不生效，染色效果体现在 chrome/气泡/分隔线上而不是纯黑白的
  // 窗口底色/文字本身
  let lo = 0
  let hi = 1
  for (let i = 0; i < BISECTION_ITERATIONS; i++) {
    const mid = (lo + hi) / 2
    if (isInGamut(oklabToLinearRgb(labAt(mid)))) lo = mid
    else hi = mid
  }
  return oklabToRgb(labAt(lo))
}

// ─── 规则 2：accent——钳制到白字可读 ─────────────────────────────────────
// Apple 的 accent 气泡恒定叠白字。把 accent 的 oklab L 向下二分（保持色相/彩度，即
// a/b 不变），直到白字对比度达到 4.5:1，取该点作为 outgoing 气泡色。
//
// 用 4.5 而不是 Apple 自己 iMessage 蓝 #007aff 实际只有的 4.02:1 ——那是 Apple 精心
// 挑选、手工调过的一小撮 accent 列表；MintBot 是自由取色器，没有人工把关，这里刻意
// 收紧一档，确保钳制算法本身兜底出的颜色总是合法

export const WHITE_ON_ACCENT_MIN_CONTRAST = 4.5

const BINARY_SEARCH_ITERATIONS = 60

function relativeLuminance([r, g, b]: RgbTuple): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

/** 主题色/角色的 oklab 明度 L，导出给测试用来验证"tint 不改变明度"这条规则 1 的
 * 核心不变量，不需要测试文件自己重新实现一遍 rgbToOklab */
export function oklabLightness(rgb: RgbTuple): number {
  return rgbToOklab(rgb).L
}

/** WCAG 相对亮度对比度（(L1+0.05)/(L2+0.05)，L1 取较亮的一方） */
export function contrastRatio(rgbA: RgbTuple, rgbB: RgbTuple): number {
  const la = relativeLuminance(rgbA)
  const lb = relativeLuminance(rgbB)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

function clampAccentForWhiteText(accentRgb: RgbTuple): RgbTuple {
  const lab = rgbToOklab(accentRgb)
  const rgbAtL = (L: number): RgbTuple => oklabToRgb({ L, a: lab.a, b: lab.b })

  // accent 本身已经够暗（比如用户选了个接近黑色的颜色），不需要钳制
  if (contrastRatio(WHITE, rgbAtL(lab.L)) >= WHITE_ON_ACCENT_MIN_CONTRAST) {
    return rgbAtL(lab.L)
  }

  // 二分：lo 恒满足对比度达标（起点 L=0，纯黑对白对比度 21:1 必然达标），
  // hi 恒不达标（起点是 accent 原始 L），收敛到达标一侧的边界
  let lo = 0
  let hi = lab.L
  for (let i = 0; i < BINARY_SEARCH_ITERATIONS; i++) {
    const mid = (lo + hi) / 2
    if (contrastRatio(WHITE, rgbAtL(mid)) >= WHITE_ON_ACCENT_MIN_CONTRAST) lo = mid
    else hi = mid
  }
  return rgbAtL(lo)
}

// ─── alpha 合成 ──────────────────────────────────────────────────────────

/** 把一个 { base, alpha } 角色合成到具体背景之上，得到不透明 RGB。标准 sRGB 空间
 * 直接按通道线性混合（不是 oklab 空间）——这与 Apple 发布 separator 的不透明等效值
 * 的算法一致（见 theme.test.ts 的外部核对用例），因为这些颜色本来就是定义成"以这个
 * alpha 叠在系统背景上会长这样"，不是拿去做感知均匀混色 */
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

// ─── 按模式查表的中性角色（Apple 发布的 UIKit iOS 系统色）──────────────────

interface NeutralTable {
  systemBackground: RgbTuple
  secondarySystemBackground: RgbTuple
  tertiarySystemBackground: RgbTuple
  incomingBubble: RgbTuple
  label: RgbTuple
  secondaryLabel: AlphaColor
  tertiaryLabel: AlphaColor
  quaternaryLabel: AlphaColor
  separator: AlphaColor
}

const DAY_TABLE: NeutralTable = {
  systemBackground: hexToRgb('#ffffff'),
  secondarySystemBackground: hexToRgb('#f2f2f7'),
  tertiarySystemBackground: hexToRgb('#ffffff'),
  incomingBubble: hexToRgb('#e9e9eb'),
  label: hexToRgb('#000000'),
  secondaryLabel: { base: hexToRgb('#3c3c43'), alpha: 0.60 },
  tertiaryLabel: { base: hexToRgb('#3c3c43'), alpha: 0.30 },
  quaternaryLabel: { base: hexToRgb('#3c3c43'), alpha: 0.18 },
  separator: { base: hexToRgb('#3c3c43'), alpha: 0.29 },
}

const NIGHT_TABLE: NeutralTable = {
  systemBackground: hexToRgb('#000000'),
  secondarySystemBackground: hexToRgb('#1c1c1e'),
  tertiarySystemBackground: hexToRgb('#2c2c2e'),
  incomingBubble: hexToRgb('#3b3b3d'),
  label: hexToRgb('#ffffff'),
  secondaryLabel: { base: hexToRgb('#ebebf5'), alpha: 0.60 },
  tertiaryLabel: { base: hexToRgb('#ebebf5'), alpha: 0.30 },
  quaternaryLabel: { base: hexToRgb('#ebebf5'), alpha: 0.18 },
  separator: { base: hexToRgb('#545458'), alpha: 0.65 },
}

// ─── 主入口 ───────────────────────────────────────────────────────────────

/** 按模式查表取中性角色，用 accent 染色（规则 1）、用 accent 钳制出 outgoing 气泡
 * （规则 2），拼出完整的 ThemeColors。tintStrength=0 时逐个角色都直接短路返回表里的
 * 原始值，字节级等于 Apple 发布值——这就是"重置为纯 Apple"按钮背后的保证 */
export function deriveTheme(input: ThemeInput): ThemeColors {
  const table = input.mode === 'day' ? DAY_TABLE : NIGHT_TABLE
  const accentLab = rgbToOklab(input.accentRgb)
  const { tintStrength } = input

  const tintSurface = (rgb: RgbTuple) => tintRole(rgb, accentLab, tintStrength, SURFACE_TINT_K)
  const tintLabel = (rgb: RgbTuple) => tintRole(rgb, accentLab, tintStrength, LABEL_TINT_K)

  return {
    background: tintSurface(table.systemBackground),
    chromeSurface: tintSurface(table.secondarySystemBackground),
    elevatedSurface: tintSurface(table.tertiarySystemBackground),
    bubbleIncoming: tintSurface(table.incomingBubble),
    bubbleOutgoing: clampAccentForWhiteText(input.accentRgb),
    labelPrimary: tintLabel(table.label),
    labelSecondary: { base: tintLabel(table.secondaryLabel.base), alpha: table.secondaryLabel.alpha },
    labelTertiary: { base: tintLabel(table.tertiaryLabel.base), alpha: table.tertiaryLabel.alpha },
    labelQuaternary: { base: tintLabel(table.quaternaryLabel.base), alpha: table.quaternaryLabel.alpha },
    separator: { base: tintSurface(table.separator.base), alpha: table.separator.alpha },
  }
}
