import { describe, it, expect } from 'vitest'
import {
  BUBBLE_BACKGROUND_MIN_CONTRAST,
  WHITE_ON_ACCENT_MIN_CONTRAST,
  compositeOverBackground,
  contrastRatio,
  deriveTheme,
  type AlphaColor,
  type RgbTuple,
  type ThemeColors,
  type ThemeMode,
} from './theme.js'

// ─── 发布值锚点：day/night 两张角色表的字面值，测试用来核对 tintStrength=0 时的
// 输出，不从 theme.ts 里重新导出内部的 DAY_TABLE/NIGHT_TABLE（保持模块的对外 API
// 只有 deriveTheme 一个入口）───────────────────────────────────────────────

const DAY_PUBLISHED = {
  bg: [0xff, 0xff, 0xff] as RgbTuple,
  bg2: [0xf2, 0xf2, 0xf7] as RgbTuple,
  bg3: [0xff, 0xff, 0xff] as RgbTuple,
  separatorOpaque: [0xc6, 0xc6, 0xc8] as RgbTuple,
  label: { base: [0x00, 0x00, 0x00] as RgbTuple, alpha: 1.0 },
  label2: { base: [0x3c, 0x3c, 0x43] as RgbTuple, alpha: 0.60 },
  label3: { base: [0x3c, 0x3c, 0x43] as RgbTuple, alpha: 0.30 },
  label4: { base: [0x3c, 0x3c, 0x43] as RgbTuple, alpha: 0.18 },
  separator: { base: [0x3c, 0x3c, 0x43] as RgbTuple, alpha: 0.29 },
  fill1: { base: [0x78, 0x78, 0x80] as RgbTuple, alpha: 0.20 },
  fill2: { base: [0x78, 0x78, 0x80] as RgbTuple, alpha: 0.14 },
  fill3: { base: [0x78, 0x78, 0x80] as RgbTuple, alpha: 0.08 },
  error: [0xb3, 0x26, 0x1e] as RgbTuple,
  onError: [0xff, 0xff, 0xff] as RgbTuple,
  errorContainer: [0xf9, 0xde, 0xdc] as RgbTuple,
  onErrorContainer: [0x41, 0x0e, 0x0b] as RgbTuple,
}

const NIGHT_PUBLISHED = {
  bg: [0x00, 0x00, 0x00] as RgbTuple,
  bg2: [0x1c, 0x1c, 0x1e] as RgbTuple,
  bg3: [0x2c, 0x2c, 0x2e] as RgbTuple,
  separatorOpaque: [0x38, 0x38, 0x3a] as RgbTuple,
  label: { base: [0xff, 0xff, 0xff] as RgbTuple, alpha: 1.0 },
  label2: { base: [0xeb, 0xeb, 0xf5] as RgbTuple, alpha: 0.60 },
  label3: { base: [0xeb, 0xeb, 0xf5] as RgbTuple, alpha: 0.30 },
  label4: { base: [0xeb, 0xeb, 0xf5] as RgbTuple, alpha: 0.18 },
  // 0.60 而不是旧模型的 0.65——0.60 现在有两个独立来源互证，0.65 一个来源都没有
  separator: { base: [0x54, 0x54, 0x58] as RgbTuple, alpha: 0.60 },
  fill1: { base: [0x78, 0x78, 0x80] as RgbTuple, alpha: 0.36 },
  fill2: { base: [0x78, 0x78, 0x80] as RgbTuple, alpha: 0.26 },
  fill3: { base: [0x78, 0x78, 0x80] as RgbTuple, alpha: 0.16 },
  error: [0xf2, 0xb8, 0xb5] as RgbTuple,
  onError: [0x60, 0x14, 0x10] as RgbTuple,
  errorContainer: [0x8c, 0x1d, 0x18] as RgbTuple,
  onErrorContainer: [0xf9, 0xde, 0xdc] as RgbTuple,
}

// 灰阶 + 饱和色两组 accent 扫描样本，覆盖"色度为零"和"色度很大"两类边界情形
const GRAYSCALE_ACCENTS: RgbTuple[] = []
for (let n = 0; n <= 255; n += 17) GRAYSCALE_ACCENTS.push([n, n, n])

const SATURATED_ACCENTS: RgbTuple[] = [
  [255, 0, 0], [0, 255, 0], [0, 0, 255],
  [255, 255, 0], [0, 255, 255], [255, 0, 255],
  [255, 77, 166], // 规格 worked example 用的亮粉色
  [128, 0, 64], [64, 128, 0], [0, 64, 128],
]

const ALL_ACCENTS = [...GRAYSCALE_ACCENTS, ...SATURATED_ACCENTS]
const MODES: ThemeMode[] = ['day', 'night']
const TINT_STEPS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]

function alphaColorFields(colors: ThemeColors): AlphaColor[] {
  return [
    colors.label, colors.label2, colors.label3, colors.label4,
    colors.separator, colors.fill1, colors.fill2, colors.fill3,
  ]
}

function opaqueFields(colors: ThemeColors): RgbTuple[] {
  return [
    colors.bg, colors.bg2, colors.bg3, colors.separatorOpaque,
    colors.bubbleIn, colors.bubbleOut, colors.labelOnAccent,
    colors.error, colors.onError, colors.errorContainer, colors.onErrorContainer,
  ]
}

// ─── 不变量 1：tintStrength=0 时字节级等于发布表 ───────────────────────────

describe('theme: tintStrength=0 时输出字节级等于发布表', () => {
  it('day 模式', () => {
    const colors = deriveTheme({ accentRgb: [255, 77, 166], mode: 'day', tintStrength: 0 })
    expect(colors.bg).toEqual(DAY_PUBLISHED.bg)
    expect(colors.bg2).toEqual(DAY_PUBLISHED.bg2)
    expect(colors.bg3).toEqual(DAY_PUBLISHED.bg3)
    expect(colors.bubbleIn).toEqual(DAY_PUBLISHED.bg2) // day: bubbleIn = bg2
    expect(colors.separatorOpaque).toEqual(DAY_PUBLISHED.separatorOpaque)
    expect(colors.label).toEqual(DAY_PUBLISHED.label)
    expect(colors.label2).toEqual(DAY_PUBLISHED.label2)
    expect(colors.label3).toEqual(DAY_PUBLISHED.label3)
    expect(colors.label4).toEqual(DAY_PUBLISHED.label4)
    expect(colors.separator).toEqual(DAY_PUBLISHED.separator)
    expect(colors.fill1).toEqual(DAY_PUBLISHED.fill1)
    expect(colors.fill2).toEqual(DAY_PUBLISHED.fill2)
    expect(colors.fill3).toEqual(DAY_PUBLISHED.fill3)
    expect(colors.error).toEqual(DAY_PUBLISHED.error)
    expect(colors.onError).toEqual(DAY_PUBLISHED.onError)
    expect(colors.errorContainer).toEqual(DAY_PUBLISHED.errorContainer)
    expect(colors.onErrorContainer).toEqual(DAY_PUBLISHED.onErrorContainer)
  })

  it('night 模式', () => {
    const colors = deriveTheme({ accentRgb: [255, 77, 166], mode: 'night', tintStrength: 0 })
    expect(colors.bg).toEqual(NIGHT_PUBLISHED.bg)
    expect(colors.bg2).toEqual(NIGHT_PUBLISHED.bg2)
    expect(colors.bg3).toEqual(NIGHT_PUBLISHED.bg3)
    expect(colors.bubbleIn).toEqual(NIGHT_PUBLISHED.bg3) // night: bubbleIn = bg3
    expect(colors.separatorOpaque).toEqual(NIGHT_PUBLISHED.separatorOpaque)
    expect(colors.label).toEqual(NIGHT_PUBLISHED.label)
    expect(colors.label2).toEqual(NIGHT_PUBLISHED.label2)
    expect(colors.label3).toEqual(NIGHT_PUBLISHED.label3)
    expect(colors.label4).toEqual(NIGHT_PUBLISHED.label4)
    expect(colors.separator).toEqual(NIGHT_PUBLISHED.separator)
    expect(colors.fill1).toEqual(NIGHT_PUBLISHED.fill1)
    expect(colors.fill2).toEqual(NIGHT_PUBLISHED.fill2)
    expect(colors.fill3).toEqual(NIGHT_PUBLISHED.fill3)
    expect(colors.error).toEqual(NIGHT_PUBLISHED.error)
    expect(colors.onError).toEqual(NIGHT_PUBLISHED.onError)
    expect(colors.errorContainer).toEqual(NIGHT_PUBLISHED.errorContainer)
    expect(colors.onErrorContainer).toEqual(NIGHT_PUBLISHED.onErrorContainer)
  })

  // 零 tint 时哪怕换一批 accent，中性角色也不应该变——中性表压根不看 accent 的值，
  // 只有 tintStrength>0 才会读它
  it.each(ALL_ACCENTS)('换 accent [%i,%i,%i] 不影响零 tint 下的中性角色（day）', (r, g, b) => {
    const colors = deriveTheme({ accentRgb: [r, g, b], mode: 'day', tintStrength: 0 })
    expect(colors.bg).toEqual(DAY_PUBLISHED.bg)
    expect(colors.separator).toEqual(DAY_PUBLISHED.separator)
  })
})

// placeholderText 的核对：参考实现发布的 placeholderText 与 label3 解析到完全相同的
// { base, alpha }，因此本模型不单独设一个角色，这里钉住这条等价关系本身
describe('theme: placeholderText 等价于 label3（不单独设角色）', () => {
  it.each(MODES)('%s 模式', (mode) => {
    const published = mode === 'day' ? DAY_PUBLISHED : NIGHT_PUBLISHED
    const colors = deriveTheme({ accentRgb: [0, 122, 255], mode, tintStrength: 0 })
    expect(colors.label3).toEqual(published.label3)
  })
})

// ─── 不变量 2：bubbleOut 白字对比度恒 ≥ 4.5:1（规则 2，clampAccentForBubble 本身
// 本次未改动）────────────────────────────────────────────────────────────

describe('theme: bubbleOut 白字对比度恒 ≥ 4.5:1', () => {
  it.each(MODES)('%s 模式：灰阶 accent 全扫', (mode) => {
    for (const accentRgb of GRAYSCALE_ACCENTS) {
      const colors = deriveTheme({ accentRgb, mode, tintStrength: 0 })
      expect(contrastRatio(colors.labelOnAccent, colors.bubbleOut)).toBeGreaterThanOrEqual(WHITE_ON_ACCENT_MIN_CONTRAST)
    }
  })

  it.each(MODES)('%s 模式：饱和 accent 全扫', (mode) => {
    for (const accentRgb of SATURATED_ACCENTS) {
      const colors = deriveTheme({ accentRgb, mode, tintStrength: 0 })
      expect(contrastRatio(colors.labelOnAccent, colors.bubbleOut)).toBeGreaterThanOrEqual(WHITE_ON_ACCENT_MIN_CONTRAST)
    }
  })

  // 近白 accent：钳制前对比度接近 1:1，必须被狠狠地钳制下去
  it('近白 accent（#fffbe0）被硬钳制，钳制后依然 ≥ 4.5:1', () => {
    const nearWhite: RgbTuple = [0xff, 0xfb, 0xe0]
    expect(contrastRatio([255, 255, 255], nearWhite)).toBeLessThan(WHITE_ON_ACCENT_MIN_CONTRAST)
    const colors = deriveTheme({ accentRgb: nearWhite, mode: 'day', tintStrength: 0 })
    expect(contrastRatio([255, 255, 255], colors.bubbleOut)).toBeGreaterThanOrEqual(WHITE_ON_ACCENT_MIN_CONTRAST)
  })

  // 近黑 accent：本身对比度已经远超阈值，钳制算法应该直接原样返回，不应该被进一步压暗
  it('近黑 accent 本身已达标，不需要钳制，原样返回', () => {
    const nearBlack: RgbTuple = [10, 5, 15]
    expect(contrastRatio([255, 255, 255], nearBlack)).toBeGreaterThanOrEqual(WHITE_ON_ACCENT_MIN_CONTRAST)
    const colors = deriveTheme({ accentRgb: nearBlack, mode: 'day', tintStrength: 0 })
    expect(colors.bubbleOut).toEqual(nearBlack)
  })

  // 规格给出的具体锚点：亮粉 #ff4da6（L 0.694）应该被钳制到 #dc2588（L 0.598），
  // 恰好 4.50:1 左右——比对比度阈值本身更强的一条回归锚点，防止二分逻辑本身跑偏
  it('worked example：#ff4da6 钳制到 #dc2588（day/night 结果相同）', () => {
    const day = deriveTheme({ accentRgb: [0xff, 0x4d, 0xa6], mode: 'day', tintStrength: 0 })
    expect(day.bubbleOut).toEqual([0xdc, 0x25, 0x88])
    const night = deriveTheme({ accentRgb: [0xff, 0x4d, 0xa6], mode: 'night', tintStrength: 0 })
    expect(night.bubbleOut).toEqual([0xdc, 0x25, 0x88])
  })

  // labelOnAccent 是钳制规则的另一半：钳制把 accent 压暗到"白字够读"为止，那么真正
  // 被画上去的文字就必须确实是白的。这条断言防止日后有人"顺手"让它跟着 tint 或跟着
  // 模式变——一旦它不再是纯白，上面两条全扫里的 4.5:1 保证就跟着一起失效了
  it.each(MODES)('%s 模式：labelOnAccent 恒为纯白，且不随 tint 变化', (mode) => {
    for (const tintStrength of [0, 0.5, 1]) {
      const colors = deriveTheme({ accentRgb: [0xff, 0x4d, 0xa6], mode, tintStrength })
      expect(colors.labelOnAccent).toEqual([255, 255, 255])
    }
  })

  it('一个被广泛使用的聊天强调色 #007aff 对白字只有 ~4.02:1，比这里的阈值更宽松', () => {
    const chatAppAccentBlue: RgbTuple = [0x00, 0x7a, 0xff]
    const cr = contrastRatio([255, 255, 255], chatAppAccentBlue)
    expect(cr).toBeLessThan(WHITE_ON_ACCENT_MIN_CONTRAST)
    expect(cr).toBeGreaterThan(4.0)
  })
})

// ─── 不变量 2b：bubbleOut 与 bg 对比度 ≥ 3.0（规则 2 的下界，未改动）──────────

describe('theme: bubbleOut 与 bg 对比度恒 ≥ 3.0（规则 2 的下界）', () => {
  it.each(MODES)('%s 模式：灰阶 accent 全扫', (mode) => {
    for (const accentRgb of GRAYSCALE_ACCENTS) {
      const colors = deriveTheme({ accentRgb, mode, tintStrength: 0 })
      expect(contrastRatio(colors.bubbleOut, colors.bg)).toBeGreaterThanOrEqual(BUBBLE_BACKGROUND_MIN_CONTRAST)
    }
  })

  it.each(MODES)('%s 模式：饱和 accent 全扫', (mode) => {
    for (const accentRgb of SATURATED_ACCENTS) {
      const colors = deriveTheme({ accentRgb, mode, tintStrength: 0 })
      expect(contrastRatio(colors.bubbleOut, colors.bg)).toBeGreaterThanOrEqual(BUBBLE_BACKGROUND_MIN_CONTRAST)
    }
  })

  it('accent [15,15,20]（chatBgRgb 默认值）在 night 模式下必须清晰区别于 #000000', () => {
    const accentRgb: RgbTuple = [15, 15, 20]
    expect(contrastRatio([255, 255, 255], accentRgb)).toBeGreaterThanOrEqual(WHITE_ON_ACCENT_MIN_CONTRAST)
    expect(contrastRatio(accentRgb, [0, 0, 0])).toBeLessThan(BUBBLE_BACKGROUND_MIN_CONTRAST)

    const colors = deriveTheme({ accentRgb, mode: 'night', tintStrength: 0 })
    expect(contrastRatio(colors.bubbleOut, colors.bg)).toBeGreaterThanOrEqual(BUBBLE_BACKGROUND_MIN_CONTRAST)
    expect(contrastRatio(colors.labelOnAccent, colors.bubbleOut)).toBeGreaterThanOrEqual(WHITE_ON_ACCENT_MIN_CONTRAST)
  })

  it('accent [15,15,20] 在 day 模式下原样返回（背景是纯白，天然远够）', () => {
    const colors = deriveTheme({ accentRgb: [15, 15, 20], mode: 'day', tintStrength: 0 })
    expect(colors.bubbleOut).toEqual([15, 15, 20])
  })
})

describe('theme: 白字可读与区别于背景两条约束必须同时成立', () => {
  it.each(MODES)('%s 模式：全部 accent（灰阶 + 饱和）同时满足两条约束', (mode) => {
    for (const accentRgb of ALL_ACCENTS) {
      const colors = deriveTheme({ accentRgb, mode, tintStrength: 0 })
      const whiteTextOk = contrastRatio(colors.labelOnAccent, colors.bubbleOut) >= WHITE_ON_ACCENT_MIN_CONTRAST
      const backgroundOk = contrastRatio(colors.bubbleOut, colors.bg) >= BUBBLE_BACKGROUND_MIN_CONTRAST
      expect(whiteTextOk, `${mode} accent=${accentRgb}: 白字对比度不达标`).toBe(true)
      expect(backgroundOk, `${mode} accent=${accentRgb}: 背景对比度不达标`).toBe(true)
    }
  })
})

// ─── 不变量 3（本次改动新增，取代旧模型"tint 不改变明度"那条不变量）：
// 对比度下限——tint 不再保持 L 恒定，因此"tint 不可能损害对比度"不再是数学上的先验，
// 改为用扫描核实一个安全下限从不被跌破 ───────────────────────────────────────
//
// 下限不是先验挑的，是先跑一遍全量扫描（26 个 accent：17 步长的灰阶 + 10 个饱和色
// × 11 档 tint 步长 × 2 个模式）量出各自的最坏情形，再挑一个明显低于最坏情形、又
// 远高于真正会读不清的阈值：
//   label vs bg 最坏情形       ≈13.75:1（day，accent=#000000，tint=1）
//   label vs bubbleIn 最坏情形 ≈9.57:1（night，accent=#ffffff，tint=1）
//   labelOnAccent vs bubbleOut 最坏情形 ≈4.503:1（这条本来就是 clampAccentForBubble
//     4.5:1 承诺本身，不随 tint 变化——bubbleOut 从不参与染色）
// 前两条都留了远大于"勉强达标"的余量（10 距 13.75 还有 37% 冗余，7 距 9.57 还有
// 37% 冗余），同时两个下限本身也都数倍于 WCAG 正文文字 4.5:1 的门槛，属于"过硬"而
// 不是"卡线"
const LABEL_ON_BG_CONTRAST_FLOOR = 10
const LABEL_ON_BUBBLE_IN_CONTRAST_FLOOR = 7

describe('theme: 对比度下限——整个 accent × tint 空间内从不跌破', () => {
  it.each(MODES)('%s 模式：全部 accent × 全部 tint 步长', (mode) => {
    for (const accentRgb of ALL_ACCENTS) {
      for (const tintStrength of TINT_STEPS) {
        const colors = deriveTheme({ accentRgb, mode, tintStrength })
        const label = `${mode} accent=${accentRgb} tint=${tintStrength}`

        expect(contrastRatio(colors.label.base, colors.bg), `${label}: label vs bg`)
          .toBeGreaterThanOrEqual(LABEL_ON_BG_CONTRAST_FLOOR)
        expect(contrastRatio(colors.label.base, colors.bubbleIn), `${label}: label vs bubbleIn`)
          .toBeGreaterThanOrEqual(LABEL_ON_BUBBLE_IN_CONTRAST_FLOOR)
        expect(contrastRatio(colors.labelOnAccent, colors.bubbleOut), `${label}: labelOnAccent vs bubbleOut`)
          .toBeGreaterThanOrEqual(WHITE_ON_ACCENT_MIN_CONTRAST)
      }
    }
  })
})

// ─── 不变量 4：tint 旋钮必须让 bg 产生肉眼可见的移动（回归——旧模型在 day 模式下
// 对 background 的染色恒为零位移，这正是本次重写的起因）──────────────────────
//
// 阈值选 5：实测 night 模式下几个饱和 accent（#ff4da6、#007aff）拖满 tint 后 bg 的
// 最大通道位移都是 9；一个"色度为零、且明度已经接近该模式自身背景明度"的消色差
// accent（比如 night 模式下接近黑的 [15,15,20] 或 [20,20,20]）位移是 0——5 卡在
// 两者中间，两侧都留了不小的余量。day 模式下由于背景本身在纯白顶点，任何有明度落差
// 的 accent 位移天然更大（同两个饱和 accent 实测是 22、31），阈值 5 在两个模式下都
// 有效
//
// 注意：新模型下"是否消色差"不再是决定位移大小的唯一因素——真正决定位移的是 accent
// 的 oklab 与该表面自身 oklab 的距离（含明度）。一个明度也接近该模式背景的消色差
// accent（如上面提到的 night 近黑灰）位移趋近于零；同一个 accent 换到 day 模式（此时
// 背景明度是纯白，跟这个偏暗的 accent 距离很大）反而会产生明显位移——这正是 Change 1
// 要修的那个 bug 本身的另一面证据，见下面单独一条断言
const VISIBLE_TINT_THRESHOLD = 5

function maxChannelDelta(a: RgbTuple, b: RgbTuple): number {
  return Math.max(...a.map((v, i) => Math.abs(v - b[i])))
}

describe('theme: 回归——饱和 accent 下，tint 滑杆必须让 bg 产生肉眼可见的移动（两个模式）', () => {
  const VISIBLE_TINT_ACCENTS: RgbTuple[] = [
    [255, 77, 166], // #ff4da6
    [0, 122, 255],  // #007aff（当前 accentRgb 默认值）
  ]

  it.each(VISIBLE_TINT_ACCENTS)('accent [%i,%i,%i]：day 模式下 bg 至少一个通道移动 ≥5', (r, g, b) => {
    const accentRgb: RgbTuple = [r, g, b]
    const t0 = deriveTheme({ accentRgb, mode: 'day', tintStrength: 0 })
    const t1 = deriveTheme({ accentRgb, mode: 'day', tintStrength: 1 })
    expect(maxChannelDelta(t1.bg, t0.bg)).toBeGreaterThanOrEqual(VISIBLE_TINT_THRESHOLD)
  })

  it.each(VISIBLE_TINT_ACCENTS)('accent [%i,%i,%i]：night 模式下 bg 至少一个通道移动 ≥5', (r, g, b) => {
    const accentRgb: RgbTuple = [r, g, b]
    const t0 = deriveTheme({ accentRgb, mode: 'night', tintStrength: 0 })
    const t1 = deriveTheme({ accentRgb, mode: 'night', tintStrength: 1 })
    expect(maxChannelDelta(t1.bg, t0.bg)).toBeGreaterThanOrEqual(VISIBLE_TINT_THRESHOLD)
  })

  // 反例：night 模式下一个消色差、且明度已经接近纯黑背景自身的 accent，达不到可见
  // 移动的阈值——用 .not 表达"这个值不该通过可见性检查"，防止阈值日后被悄悄调宽到
  // 连这种"实质上什么都没变"的输入都能通过
  it('反例：night 模式下 accentRgb [15, 15, 20]（消色差且已接近纯黑）达不到可见移动', () => {
    const accentRgb: RgbTuple = [15, 15, 20]
    const t0 = deriveTheme({ accentRgb, mode: 'night', tintStrength: 0 })
    const t1 = deriveTheme({ accentRgb, mode: 'night', tintStrength: 1 })
    expect(maxChannelDelta(t1.bg, t0.bg)).toBeLessThan(VISIBLE_TINT_THRESHOLD)
  })

  // 同一个 accent 换到 day 模式：新模型下反而能清楚移动——这正是 Change 1 要修的
  // bug（"day 的纯白背景在旧模型下永远不可能被染色"）的直接证据。旧模型下这个 accent
  // 在 day 模式的位移只有 1；新模型下远超阈值
  it('同一个 accent [15, 15, 20] 换到 day 模式：新模型下 bg 能被明显染色（旧模型的 bug 场景）', () => {
    const accentRgb: RgbTuple = [15, 15, 20]
    const t0 = deriveTheme({ accentRgb, mode: 'day', tintStrength: 0 })
    const t1 = deriveTheme({ accentRgb, mode: 'day', tintStrength: 1 })
    expect(maxChannelDelta(t1.bg, t0.bg)).toBeGreaterThanOrEqual(VISIBLE_TINT_THRESHOLD)
  })
})

// ─── 不变量 5：error 色板不受 tint/accent 影响 ─────────────────────────────

describe('theme: error 色板不受 tint、不受 accent 影响', () => {
  it.each(MODES)('%s 模式：全部 accent × 全部 tint 步长，error 四个角色都等于发布值', (mode) => {
    const published = mode === 'day' ? DAY_PUBLISHED : NIGHT_PUBLISHED
    for (const accentRgb of ALL_ACCENTS) {
      for (const tintStrength of TINT_STEPS) {
        const colors = deriveTheme({ accentRgb, mode, tintStrength })
        expect(colors.error).toEqual(published.error)
        expect(colors.onError).toEqual(published.onError)
        expect(colors.errorContainer).toEqual(published.errorContainer)
        expect(colors.onErrorContainer).toEqual(published.onErrorContainer)
      }
    }
  })
})

// ─── 不变量 6：每个输出通道都是 0-255 的整数 ────────────────────────────────

describe('theme: 每个输出通道都是 0-255 的整数', () => {
  function assertIntegerChannels(rgb: RgbTuple, label: string) {
    for (const channel of rgb) {
      expect(Number.isInteger(channel), label).toBe(true)
      expect(channel, label).toBeGreaterThanOrEqual(0)
      expect(channel, label).toBeLessThanOrEqual(255)
    }
  }

  it.each(MODES)('%s 模式：全部角色 × 全部 accent × 多档 tint', (mode) => {
    for (const accentRgb of ALL_ACCENTS) {
      for (const tintStrength of [0, 0.33, 0.5, 0.66, 1]) {
        const colors = deriveTheme({ accentRgb, mode, tintStrength })
        const label = `${mode} accent=${accentRgb} tint=${tintStrength}`
        for (const rgb of opaqueFields(colors)) assertIntegerChannels(rgb, label)
        for (const alphaColor of alphaColorFields(colors)) assertIntegerChannels(alphaColor.base, label)
      }
    }
  })
})

// ─── 不变量 7：alpha 合成到不透明背景之上 ───────────────────────────────────
// day 组：separator（#3c3c43 @ 0.29）合成到 bg（#ffffff）上精确等于 separatorOpaque
// （#c6c6c8）——两个独立发布值在数学上互相印证，day 一侧仍然成立。
//
// night 组：本次把 separator 的 alpha 从 0.65 改成了有实测支持的 0.60（见上方
// NIGHT_PUBLISHED 注释），但 separatorOpaque（#38383a）这个独立发布值本身仍是旧的
// ——实测发现它对应的其实是旧 0.65 alpha 的合成结果（(0x54,0x54,0x58)@0.65 合成到
// 黑上 ≈ #373739，与 #38383a 相差 ≤1），而不是修正后的 0.60（0.60 合成到黑上算出来
// 是 #323235，跟 #38383a 相差达 5-6，明显对不上）。这说明 separator 的透明度与
// separatorOpaque 这两个独立发布值本身来自不同的取值代际，night 一侧不能再互相
// 验证——如实记录这个新发现的不一致，不用旧的近似容差掩盖过去
describe('theme: alpha 合成到不透明背景之上', () => {
  it('day: separator(#3c3c43 @ 0.29) 合成到 bg(#ffffff) 上 = separatorOpaque(#c6c6c8)（精确）', () => {
    const colors = deriveTheme({ accentRgb: [128, 128, 128], mode: 'day', tintStrength: 0 })
    const composited = compositeOverBackground(colors.separator, colors.bg)
    expect(composited).toEqual(colors.separatorOpaque)
  })

  it('night: separator(#545458 @ 0.60) 合成到 bg(#000000) 上 = #323235（精确，不再与 separatorOpaque 互证，见上方说明）', () => {
    const colors = deriveTheme({ accentRgb: [128, 128, 128], mode: 'night', tintStrength: 0 })
    const composited = compositeOverBackground(colors.separator, colors.bg)
    expect(composited).toEqual([0x32, 0x32, 0x35])
  })
})
