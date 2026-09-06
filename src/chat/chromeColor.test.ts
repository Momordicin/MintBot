import { describe, it, expect } from 'vitest'
import {
  BUBBLE_BOT_ALPHA,
  BUBBLE_USER_ALPHA,
  DARK_BAND_MAX_L,
  LIGHT_BAND_MIN_L,
  bubbleMixParams,
  deriveBubbleColors,
  deriveChromeSurfaceColor,
  deriveTitlebarOverlay,
  deriveVeilColor,
  mixOklab,
  oklabLightness,
  type RgbTuple,
} from './chromeColor.js'

// ─── 三段式分档边界（TDD §2.2 三段式表：L < 0.35 / L > 0.65 / 0.35 ≤ L ≤ 0.65）───

describe('chromeColor: bubbleMixParams 分档边界', () => {
  it('L 恰好小于 0.35（深色主题）：bot 15% 白、user 80% 白', () => {
    const params = bubbleMixParams(DARK_BAND_MAX_L - 0.0001)
    expect(params).toEqual({ botTarget: [255, 255, 255], botRatio: 0.15, userTarget: [255, 255, 255], userRatio: 0.80 })
  })

  it('L 恰好等于 0.35 落入中间段（边界不含深色段）', () => {
    const params = bubbleMixParams(DARK_BAND_MAX_L)
    expect(params).toEqual({ botTarget: [0, 0, 0], botRatio: 0.45, userTarget: [255, 255, 255], userRatio: 0.45 })
  })

  it('L 恰好等于 0.65 落入中间段（边界不含浅色段）', () => {
    const params = bubbleMixParams(LIGHT_BAND_MIN_L)
    expect(params).toEqual({ botTarget: [0, 0, 0], botRatio: 0.45, userTarget: [255, 255, 255], userRatio: 0.45 })
  })

  it('L 恰好大于 0.65（浅色主题）：bot 80% 黑、user 15% 黑', () => {
    const params = bubbleMixParams(LIGHT_BAND_MIN_L + 0.0001)
    expect(params).toEqual({ botTarget: [0, 0, 0], botRatio: 0.80, userTarget: [0, 0, 0], userRatio: 0.15 })
  })

  it('中间段（如 L = 0.5）两个气泡分居背景两侧', () => {
    const params = bubbleMixParams(0.5)
    expect(params.botTarget).toEqual([0, 0, 0])
    expect(params.userTarget).toEqual([255, 255, 255])
  })
})

// ─── oklab vs sRGB 的可验证正确性锚点（TDD §2.2 worked example）─────────────
// 默认主题 [15, 15, 20]：bot 15% 白 → rgb(44, 44, 49)；user 80% 白 → rgb(200, 200, 202)。
// TDD 原文同时指出，如果按 sRGB 通道线性插值反解会得到 12.5% / 77% 而非 15% / 80%——
// 这里不重复反解，只验证正向 oklab 混合本身产出与文档给出的具体数字一致，这就足以
// 证明混合确实发生在 oklab 空间（sRGB 空间的线性插值不会产出这两个具体数字）。

describe('chromeColor: 默认主题 [15,15,20] 的 oklab 混合 worked example', () => {
  const theme: RgbTuple = [15, 15, 20]

  it('主题色本身的 oklab L 落在深色主题段（< 0.35）', () => {
    expect(oklabLightness(theme)).toBeLessThan(DARK_BAND_MAX_L)
  })

  it('bot 15% 白 → rgb(44, 44, 49)', () => {
    expect(mixOklab(theme, [255, 255, 255], 0.15)).toEqual([44, 44, 49])
  })

  it('user 80% 白 → rgb(200, 200, 202)', () => {
    expect(mixOklab(theme, [255, 255, 255], 0.80)).toEqual([200, 200, 202])
  })

  it('deriveBubbleColors 组合出完整的 rgba() 字符串（含 §2.2 规定的固定 alpha）', () => {
    const { botBg, userBg } = deriveBubbleColors(theme)
    expect(botBg).toBe(`rgba(44, 44, 49, ${BUBBLE_BOT_ALPHA})`)
    expect(userBg).toBe(`rgba(200, 200, 202, ${BUBBLE_USER_ALPHA})`)
  })
})

// ─── 硬约束 1：两个气泡都必须相对背景有可辨差异（不止 3 个采样点，扫全部灰阶明度）───

describe('chromeColor: 硬约束——两个气泡在任意主题明度下都能与背景区分', () => {
  it('灰阶 0-255 每一档主题色，bot/user 气泡底色都不等于原始主题色', () => {
    for (let n = 0; n <= 255; n++) {
      const theme: RgbTuple = [n, n, n]
      const L = oklabLightness(theme)
      const { botTarget, botRatio, userTarget, userRatio } = bubbleMixParams(L)
      const bot = mixOklab(theme, botTarget, botRatio)
      const user = mixOklab(theme, userTarget, userRatio)
      expect(bot, `n=${n} bot 不应与背景相同`).not.toEqual(theme)
      expect(user, `n=${n} user 不应与背景相同`).not.toEqual(theme)
    }
  })
})

// ─── 硬约束 2：user 气泡在任意主题明度下都比 bot 更浅（扫全部灰阶明度，不止 3 个采样点）───

describe('chromeColor: 硬约束——user 气泡恒比 bot 气泡浅', () => {
  it('灰阶 0-255 每一档主题色，user 气泡混合结果的 oklab L 都严格大于 bot', () => {
    for (let n = 0; n <= 255; n++) {
      const theme: RgbTuple = [n, n, n]
      const L = oklabLightness(theme)
      const { botTarget, botRatio, userTarget, userRatio } = bubbleMixParams(L)
      const botL = oklabLightness(mixOklab(theme, botTarget, botRatio))
      const userL = oklabLightness(mixOklab(theme, userTarget, userRatio))
      expect(userL, `n=${n} (L=${L.toFixed(3)}) user 应比 bot 更浅`).toBeGreaterThan(botL)
    }
  })
})

// ─── 硬约束补充：上面两条只扫了灰阶，而灰阶的 oklab a/b 恒为 0 ───────────────
// 灰阶扫不到的风险是 sRGB 色域裁剪：饱和色混合后可能落到色域外被 oklabToRgb 夹回来，
// 从而扰动 L。数学上 mixOklab 的 L 输出对 t 是线性的、与主题色的 a/b 无关，所以顺序
// 约束结构上就与色度无关；但那是推理，不是这份测试证明的。补一组饱和色把它变成实证
const SATURATED_THEMES: RgbTuple[] = [
  [255, 0, 0], [0, 255, 0], [0, 0, 255],
  [255, 255, 0], [0, 255, 255], [255, 0, 255],
  [128, 0, 0], [0, 128, 0], [0, 0, 128],
  [255, 128, 0], [128, 0, 255], [0, 128, 255],
  [64, 16, 96], [200, 220, 40], [16, 200, 120],
]

describe('chromeColor: 硬约束在饱和主题色下同样成立', () => {
  it.each(SATURATED_THEMES)('主题色 [%i, %i, %i]：两个气泡都可辨，且 user 恒比 bot 浅', (r, g, b) => {
    const theme: RgbTuple = [r, g, b]
    const L = oklabLightness(theme)
    const { botTarget, botRatio, userTarget, userRatio } = bubbleMixParams(L)
    const bot = mixOklab(theme, botTarget, botRatio)
    const user = mixOklab(theme, userTarget, userRatio)
    expect(bot).not.toEqual(theme)
    expect(user).not.toEqual(theme)
    expect(oklabLightness(user)).toBeGreaterThan(oklabLightness(bot))
  })
})

// ─── 纱色方向（白纱/黑纱）：由 readableColor() 判断 ─────────────────────────

describe('chromeColor: deriveVeilColor 纱色方向', () => {
  it('深色主题（默认 [15,15,20]）→ 白纱', () => {
    expect(deriveVeilColor([15, 15, 20])).toBe('#fff')
  })

  it('浅色主题（接近纯白）→ 黑纱', () => {
    expect(deriveVeilColor([240, 240, 245])).toBe('#000')
  })
})

// ─── 承载内容的表面：标题栏底 / 输入栏底 ────────────────────────────────────

describe('chromeColor: deriveChromeSurfaceColor 标题栏/输入栏底色', () => {
  it('直接取主题色本身、固定 alpha 0.40（不做黑白混合）', () => {
    expect(deriveChromeSurfaceColor([15, 15, 20])).toBe('rgba(15, 15, 20, 0.4)')
  })
})

// ─── 原生窗口按钮条带 IPC 载荷 ───────────────────────────────────────────────

describe('chromeColor: deriveTitlebarOverlay', () => {
  it('color 恒为 alpha=0（原生按钮条带完全透明），symbolColor 复用纱色方向判断', () => {
    expect(deriveTitlebarOverlay([15, 15, 20])).toEqual({ color: '#0f0f1400', symbolColor: '#fff' })
  })

  it('浅色主题下 symbolColor 翻转为黑色，避免白底白符号', () => {
    expect(deriveTitlebarOverlay([240, 240, 245])).toEqual({ color: '#f0f0f500', symbolColor: '#000' })
  })
})
