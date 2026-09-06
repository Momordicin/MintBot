import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DEFAULT_DISPLAY_CONFIG, parseDisplayConfig, isValidTintStrength, clampTintStrength } from './displayConfig.js'

describe('parseDisplayConfig', () => {
  // 部分既有用例（chatBgRgb/chatBgOpacity 的类型错误分支）只 vi.spyOn 而不 restore，
  // 之前恰好没有后续用例断言"没被调用过"所以没暴露；本次新增的用例里有这类断言，
  // 在每个用例开始前统一 restore 一次，避免跨用例的 spy 调用计数互相污染
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('raw 为 null（迁移前的旧行/从未写过的行）时返回全部默认值，不告警', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseDisplayConfig(null)).toEqual(DEFAULT_DISPLAY_CONFIG)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('JSON 解析失败时返回全部默认值并告警', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseDisplayConfig('{not valid json')).toEqual(DEFAULT_DISPLAY_CONFIG)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('完整合法对象原样使用', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({
      chatBgRgb: [10, 20, 30],
      chatBgOpacity: 0.3,
      themeMode: 'night',
      accentRgb: [40, 50, 60],
      tintStrength: 0.5,
    })
    expect(parseDisplayConfig(raw)).toEqual({
      chatBgRgb: [10, 20, 30],
      chatBgOpacity: 0.3,
      themeMode: 'night',
      accentRgb: [40, 50, 60],
      tintStrength: 0.5,
    })
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('chatBgRgb 缺失时回退默认值，chatBgOpacity 不受影响', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({ chatBgOpacity: 0.9 })
    expect(parseDisplayConfig(raw)).toEqual({ ...DEFAULT_DISPLAY_CONFIG, chatBgRgb: DEFAULT_DISPLAY_CONFIG.chatBgRgb, chatBgOpacity: 0.9 })
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('chatBgRgb 类型错误（非数组）时回退默认值', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({ chatBgRgb: 'red', chatBgOpacity: 0.5 })
    expect(parseDisplayConfig(raw).chatBgRgb).toEqual(DEFAULT_DISPLAY_CONFIG.chatBgRgb)
  })

  it('chatBgRgb 元素超出 0-255 范围时回退默认值', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({ chatBgRgb: [10, 20, 300], chatBgOpacity: 0.5 })
    expect(parseDisplayConfig(raw).chatBgRgb).toEqual(DEFAULT_DISPLAY_CONFIG.chatBgRgb)
  })

  it('chatBgRgb 元素为非整数时回退默认值', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({ chatBgRgb: [10, 20, 30.5], chatBgOpacity: 0.5 })
    expect(parseDisplayConfig(raw).chatBgRgb).toEqual(DEFAULT_DISPLAY_CONFIG.chatBgRgb)
  })

  it('chatBgOpacity 缺失时回退默认值，chatBgRgb 不受影响', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({ chatBgRgb: [1, 2, 3] })
    // accentRgb 同样缺失，读时取固定的 DEFAULT_DISPLAY_CONFIG.accentRgb，不 carry over
    // 已解析出的 chatBgRgb（[1, 2, 3]）——这里刻意选了一个不同于默认值的 chatBgRgb，
    // 确认 accentRgb 不会跟着它变
    expect(parseDisplayConfig(raw)).toEqual({ ...DEFAULT_DISPLAY_CONFIG, chatBgRgb: [1, 2, 3], chatBgOpacity: DEFAULT_DISPLAY_CONFIG.chatBgOpacity, accentRgb: DEFAULT_DISPLAY_CONFIG.accentRgb })
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('chatBgOpacity 超出 0-1 范围时回退默认值', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({ chatBgRgb: [1, 2, 3], chatBgOpacity: 1.5 })
    expect(parseDisplayConfig(raw).chatBgOpacity).toBe(DEFAULT_DISPLAY_CONFIG.chatBgOpacity)
  })

  it('chatBgOpacity 类型错误（字符串）时回退默认值', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({ chatBgRgb: [1, 2, 3], chatBgOpacity: '0.5' })
    expect(parseDisplayConfig(raw).chatBgOpacity).toBe(DEFAULT_DISPLAY_CONFIG.chatBgOpacity)
  })

  // ─── themeMode/accentRgb/tintStrength：本次新增字段 ──────────────────────

  it('旧 blob 完全没有三个新字段时，三者都取默认值，且不告警（schema 演进的正常情况，不是脏数据）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({ chatBgRgb: [1, 2, 3], chatBgOpacity: 0.5 })
    expect(parseDisplayConfig(raw)).toEqual({
      chatBgRgb: [1, 2, 3],
      chatBgOpacity: 0.5,
      themeMode: DEFAULT_DISPLAY_CONFIG.themeMode,
      accentRgb: DEFAULT_DISPLAY_CONFIG.accentRgb,
      tintStrength: DEFAULT_DISPLAY_CONFIG.tintStrength,
    })
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('accentRgb 缺失时回退到固定默认色 [0, 122, 255]，不 carry over（已解析的）chatBgRgb', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({ chatBgRgb: [123, 45, 67], chatBgOpacity: 0.5 })
    expect(parseDisplayConfig(raw).accentRgb).toEqual([0, 122, 255])
    expect(parseDisplayConfig(raw).accentRgb).toEqual(DEFAULT_DISPLAY_CONFIG.accentRgb)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('accentRgb 类型错误时告警并回退到固定默认色，不 carry over（已解析的）chatBgRgb', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({ chatBgRgb: [123, 45, 67], chatBgOpacity: 0.5, accentRgb: 'red' })
    expect(parseDisplayConfig(raw).accentRgb).toEqual(DEFAULT_DISPLAY_CONFIG.accentRgb)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('themeMode 不是 day/night/auto 之一时告警并回退默认值', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({ chatBgRgb: [1, 2, 3], chatBgOpacity: 0.5, themeMode: 'dusk' })
    expect(parseDisplayConfig(raw).themeMode).toBe(DEFAULT_DISPLAY_CONFIG.themeMode)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('tintStrength 在 [0, 1] 范围内的合法值原样使用，不告警', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({ chatBgRgb: [1, 2, 3], chatBgOpacity: 0.5, tintStrength: 0.42 })
    expect(parseDisplayConfig(raw).tintStrength).toBe(0.42)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('tintStrength 超过 1 时被夹回 1，不告警（越界数字是夹取而非拒绝）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({ chatBgRgb: [1, 2, 3], chatBgOpacity: 0.5, tintStrength: 1.5 })
    expect(parseDisplayConfig(raw).tintStrength).toBe(1)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('tintStrength 小于 0 时被夹回 0，不告警', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({ chatBgRgb: [1, 2, 3], chatBgOpacity: 0.5, tintStrength: -0.3 })
    expect(parseDisplayConfig(raw).tintStrength).toBe(0)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('tintStrength 类型错误（字符串）时告警并回退默认值', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({ chatBgRgb: [1, 2, 3], chatBgOpacity: 0.5, tintStrength: 'not-a-number' })
    expect(parseDisplayConfig(raw).tintStrength).toBe(DEFAULT_DISPLAY_CONFIG.tintStrength)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

// JSON 本身无法编码 NaN/Infinity（JSON.stringify 把它们转成 null，JSON.parse 拒绝裸
// Infinity 字面量），所以经 parseDisplayConfig 这条路径永远碰不到"类型是 number 但非
// 有限值"的输入——直接单测 isValidTintStrength/clampTintStrength 这两个导出函数本身，
// 覆盖任务要求的"非有限输入"这一档
describe('isValidTintStrength / clampTintStrength', () => {
  it('NaN 不是合法值', () => {
    expect(isValidTintStrength(NaN)).toBe(false)
  })

  it('Infinity / -Infinity 不是合法值', () => {
    expect(isValidTintStrength(Infinity)).toBe(false)
    expect(isValidTintStrength(-Infinity)).toBe(false)
  })

  it('[0, 1] 内的有限数字合法', () => {
    expect(isValidTintStrength(0)).toBe(true)
    expect(isValidTintStrength(1)).toBe(true)
    expect(isValidTintStrength(0.5)).toBe(true)
  })

  it('超出 [0, 1] 的有限数字仍然合法（越界值靠 clampTintStrength 夹取，不在这里拒绝）', () => {
    expect(isValidTintStrength(1.5)).toBe(true)
    expect(isValidTintStrength(-0.5)).toBe(true)
  })

  it('clampTintStrength 把两端越界值夹回边界，范围内的值原样返回', () => {
    expect(clampTintStrength(1.5)).toBe(1)
    expect(clampTintStrength(-0.5)).toBe(0)
    expect(clampTintStrength(0.42)).toBe(0.42)
  })
})
