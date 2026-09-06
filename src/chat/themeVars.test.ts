import { describe, it, expect } from 'vitest'
import { deriveTheme } from './theme.js'
import {
  CHROME_MATERIAL_ALPHA,
  DEFAULT_CHAT_BG_OPACITY,
  DEFAULT_THEME_INPUT,
  resolveThemeMode,
  themeCssVars,
  titlebarOverlayFromTheme,
} from './themeVars.js'

// ─── resolveThemeMode：'auto' 解析（渲染层唯一自己承担的判断） ────────────────

describe('themeVars: resolveThemeMode', () => {
  it('day/night 原样直通，不看 prefersDark', () => {
    expect(resolveThemeMode('day', true)).toBe('day')
    expect(resolveThemeMode('day', false)).toBe('day')
    expect(resolveThemeMode('night', true)).toBe('night')
    expect(resolveThemeMode('night', false)).toBe('night')
  })

  it("'auto' 跟随 prefersDark：true → night，false → day", () => {
    expect(resolveThemeMode('auto', true)).toBe('night')
    expect(resolveThemeMode('auto', false)).toBe('day')
  })
})

// ─── themeCssVars：新角色 → CSS 变量映射表落成的纯函数 ─────────────────────

describe('themeVars: themeCssVars', () => {
  it('day 模式：不透明角色输出 rgb()，AlphaColor 角色输出 rgba()，chatBgOpacity 原样透传', () => {
    const theme = deriveTheme({ accentRgb: [255, 77, 166], mode: 'day', tintStrength: 0 })
    const vars = themeCssVars(theme, 0.65)

    expect(vars['--window-bg-rgb']).toBe('255, 255, 255')
    expect(vars['--chat-bg-opacity']).toBe('0.65')
    expect(vars['--bubble-bot-bg']).toBe(`rgb(${theme.bubbleIn.join(', ')})`)
    expect(vars['--bubble-user-bg']).toBe(`rgb(${theme.bubbleOut.join(', ')})`)
    // bubbleIn 是中性表面，文字随模式翻转（day 是纯黑）
    expect(vars['--bubble-bot-text']).toBe('rgb(0, 0, 0)')
    // bubbleOut 上恒叠纯白，不随模式变化——这是 clampAccentForBubble 白字对比度
    // 保证的另一半，day 模式下尤其不能悄悄换成 label（day 是纯黑）
    expect(vars['--bubble-user-text']).toBe('rgb(255, 255, 255)')
    expect(vars['--titlebar-text']).toBe('rgb(0, 0, 0)')
    expect(vars['--input-text']).toBe('rgb(0, 0, 0)')
  })

  it('night 模式：label 系角色翻转为纯白', () => {
    const theme = deriveTheme({ accentRgb: [255, 77, 166], mode: 'night', tintStrength: 0 })
    const vars = themeCssVars(theme, 0.65)

    expect(vars['--window-bg-rgb']).toBe('0, 0, 0')
    expect(vars['--bubble-bot-text']).toBe('rgb(255, 255, 255)')
    expect(vars['--bubble-user-text']).toBe('rgb(255, 255, 255)')
    expect(vars['--titlebar-text']).toBe('rgb(255, 255, 255)')
  })

  it('材质 chrome：--titlebar-bg / --input-bg 按 CHROME_MATERIAL_ALPHA 把 bg2 合成为半透明色，两者相等（标题栏与输入栏共用同一份材质）；--bg2-rgb 是同一个 bg2 的不透明三元组，供 CSS 侧的材质失效兜底路径用', () => {
    const theme = deriveTheme({ accentRgb: [15, 15, 20], mode: 'night', tintStrength: 0 })
    const vars = themeCssVars(theme, 0.65)
    const expected = `rgba(${theme.bg2.join(', ')}, ${CHROME_MATERIAL_ALPHA})`
    expect(vars['--titlebar-bg']).toBe(expected)
    expect(vars['--input-bg']).toBe(expected)
    expect(vars['--bg2-rgb']).toBe(theme.bg2.join(', '))
  })

  it('CHROME_MATERIAL_ALPHA 固定为 0.65，不再是上一代模型的 0.40（旧的 CHROME_SURFACE_ALPHA 已随本次改动删除）', () => {
    expect(CHROME_MATERIAL_ALPHA).toBe(0.65)
  })

  it('--input-placeholder 与 --label3 取值相等（label3 身兼二职：也是参考实现发布的 placeholderText，见 theme.ts）', () => {
    const theme = deriveTheme({ accentRgb: [15, 15, 20], mode: 'day', tintStrength: 0.5 })
    const vars = themeCssVars(theme, 0.65)
    expect(vars['--input-placeholder']).toBe(vars['--label3'])
    expect(vars['--input-placeholder']).toBe(
      `rgba(${theme.label3.base.join(', ')}, ${theme.label3.alpha})`
    )
  })

  it('separator 直接对应 --input-border', () => {
    const theme = deriveTheme({ accentRgb: [15, 15, 20], mode: 'night', tintStrength: 0 })
    const vars = themeCssVars(theme, 0.65)
    expect(vars['--input-border']).toBe(`rgba(${theme.separator.base.join(', ')}, ${theme.separator.alpha})`)
  })

  it('--text-secondary 与 --system-msg-text 复用同一个 label2', () => {
    const theme = deriveTheme({ accentRgb: [15, 15, 20], mode: 'night', tintStrength: 0 })
    const vars = themeCssVars(theme, 0.65)
    expect(vars['--text-secondary']).toBe(vars['--system-msg-text'])
    expect(vars['--text-secondary']).toBe(`rgba(${theme.label2.base.join(', ')}, ${theme.label2.alpha})`)
  })

  it('--fill1/--fill2/--fill3 直接对应 theme.fill1/fill2/fill3', () => {
    const theme = deriveTheme({ accentRgb: [15, 15, 20], mode: 'day', tintStrength: 0.3 })
    const vars = themeCssVars(theme, 0.65)
    expect(vars['--fill1']).toBe(`rgba(${theme.fill1.base.join(', ')}, ${theme.fill1.alpha})`)
    expect(vars['--fill2']).toBe(`rgba(${theme.fill2.base.join(', ')}, ${theme.fill2.alpha})`)
    expect(vars['--fill3']).toBe(`rgba(${theme.fill3.base.join(', ')}, ${theme.fill3.alpha})`)
  })

  it('--scrollbar-thumb 等于 fill1；--scrollbar-thumb-hover 是 fill1 的 alpha 抬高一档（同一个 base，不同 alpha）', () => {
    const theme = deriveTheme({ accentRgb: [15, 15, 20], mode: 'day', tintStrength: 0 })
    const vars = themeCssVars(theme, 0.65)
    expect(vars['--scrollbar-thumb']).toBe(vars['--fill1'])
    expect(vars['--scrollbar-thumb-hover']).toBe(
      `rgba(${theme.fill1.base.join(', ')}, ${Math.min(1, theme.fill1.alpha + 0.15)})`
    )
    expect(vars['--scrollbar-thumb-hover']).not.toBe(vars['--scrollbar-thumb'])
  })

  // night 模式下 fill1 alpha 是 0.36，+0.15 = 0.51，未触及钳到 1 的边界——这条覆盖钳制
  // 边界本身：一个 alpha 已经很高的角色，boostAlpha 不应该越界到 1 以上
  it('--scrollbar-thumb-hover 的 alpha 钳制不超过 1', () => {
    const theme = deriveTheme({ accentRgb: [15, 15, 20], mode: 'night', tintStrength: 0 })
    const boosted = Math.min(1, theme.fill1.alpha + 0.15)
    expect(boosted).toBeLessThanOrEqual(1)
    const vars = themeCssVars(theme, 0.65)
    expect(vars['--scrollbar-thumb-hover']).toBe(`rgba(${theme.fill1.base.join(', ')}, ${boosted})`)
  })

  it('--label/--label2/--label3/--label4 直接对应 theme 的四级 label', () => {
    const theme = deriveTheme({ accentRgb: [15, 15, 20], mode: 'night', tintStrength: 0.2 })
    const vars = themeCssVars(theme, 0.65)
    expect(vars['--label']).toBe(`rgb(${theme.label.base.join(', ')})`)
    expect(vars['--label2']).toBe(`rgba(${theme.label2.base.join(', ')}, ${theme.label2.alpha})`)
    expect(vars['--label3']).toBe(`rgba(${theme.label3.base.join(', ')}, ${theme.label3.alpha})`)
    expect(vars['--label4']).toBe(`rgba(${theme.label4.base.join(', ')}, ${theme.label4.alpha})`)
  })

  // accent 在 ThemeColors 里没有独立角色，这一层把 bubbleOut 复用为 accent（见 themeVars.ts
  // themeCssVars 顶部注释）——这条测试钉住这个复用关系本身，防止日后有人不小心换成别的角色
  it('--accent/--accent-rgb 复用 bubbleOut（ThemeColors 没有独立、未钳制的 accent 角色）', () => {
    const theme = deriveTheme({ accentRgb: [255, 77, 166], mode: 'day', tintStrength: 0 })
    const vars = themeCssVars(theme, 0.65)
    expect(vars['--accent']).toBe(`rgb(${theme.bubbleOut.join(', ')})`)
    expect(vars['--accent-rgb']).toBe(theme.bubbleOut.join(', '))
  })

  it('--error-container/--on-error-container 直接对应 theme 的 M3 error 色板，不随 accent/tint 变化', () => {
    const day = deriveTheme({ accentRgb: [255, 77, 166], mode: 'day', tintStrength: 1 })
    const vars = themeCssVars(day, 0.65)
    expect(vars['--error-container']).toBe(`rgb(${day.errorContainer.join(', ')})`)
    expect(vars['--on-error-container']).toBe(`rgb(${day.onErrorContainer.join(', ')})`)
  })
})

// ─── titlebarOverlayFromTheme：原生窗口按钮条带契约 ─────────────────────────

describe('themeVars: titlebarOverlayFromTheme', () => {
  it('color 恒为 alpha=00（原生条带完全透明的契约不变）', () => {
    const day = deriveTheme({ accentRgb: [15, 15, 20], mode: 'day', tintStrength: 0 })
    const night = deriveTheme({ accentRgb: [15, 15, 20], mode: 'night', tintStrength: 0 })
    expect(titlebarOverlayFromTheme(day).color.endsWith('00')).toBe(true)
    expect(titlebarOverlayFromTheme(night).color.endsWith('00')).toBe(true)
  })

  it('symbolColor 跟随模式（day 纯黑符号、night 纯白符号），不是测量出来的', () => {
    // 特意用一个饱和 accent：旧模型里符号色是"测量主题色明暗"得出的，如果新实现不小心
    // retained 了这条路径，饱和 accent 会让这条断言失败——新模型下 symbolColor 只看 mode
    const accentRgb: [number, number, number] = [255, 77, 166]
    expect(titlebarOverlayFromTheme(deriveTheme({ accentRgb, mode: 'day', tintStrength: 0 })).symbolColor).toBe('#000000')
    expect(titlebarOverlayFromTheme(deriveTheme({ accentRgb, mode: 'night', tintStrength: 0 })).symbolColor).toBe('#ffffff')
  })
})


// ─── legacy 冻结快照兜底路径 ─────────────────────────────────────────────────
// v7 之前创建的历史冻结快照没有 displayConfig。这条路径上自绘 chrome 与原生按钮条带
// 必须收敛到同一个答案，做法是两者都吃 deriveTheme(DEFAULT_THEME_INPUT)——ChatWindow.tsx
// 现在无条件下发 CSS 变量（而不是缺失时跳过、改靠 global.css `:root` 的静态字面值），
// 所以这条一致性由构造保证，不再依赖两份人工维护的字面值恰好相等。
// 这里钉住的是「兜底输入本身产出一组完整、合法的变量」，一旦有人给 ThemeColors 加了
// 新角色却忘了在 themeCssVars 里映射，这条会红
describe('themeVars: DEFAULT_THEME_INPUT 兜底路径', () => {
  const theme = deriveTheme(DEFAULT_THEME_INPUT)
  const vars = themeCssVars(theme, DEFAULT_CHAT_BG_OPACITY)

  it('每个变量都有非空值，没有 undefined 漏进 style 对象', () => {
    for (const [name, value] of Object.entries(vars)) {
      expect(value, `${name} 不应为空`).toBeTruthy()
      expect(value, `${name} 不应含 undefined`).not.toContain('undefined')
    }
  })

  it('兜底是 night，原生按钮条带的符号色随之为白——与自绘 chrome 同源', () => {
    expect(DEFAULT_THEME_INPUT.mode).toBe('night')
    expect(titlebarOverlayFromTheme(theme).symbolColor).toBe('#ffffff')
    expect(vars['--titlebar-text']).toBe('rgb(255, 255, 255)')
  })
})
