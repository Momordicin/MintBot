import { describe, it, expect } from 'vitest'
import { hexToRgb, percentToTintStrength, rgbToHex, tintStrengthToPercent } from './themeControls.js'

describe('rgbToHex / hexToRgb', () => {
  it('rgbToHex 把 RGB 元组转成小写 6 位 hex，零值补零', () => {
    expect(rgbToHex([0, 0, 0])).toBe('#000000')
    expect(rgbToHex([255, 255, 255])).toBe('#ffffff')
    expect(rgbToHex([15, 15, 20])).toBe('#0f0f14')
  })

  it('hexToRgb 把 hex 还原成 RGB 元组，round-trip 与 rgbToHex 互逆', () => {
    expect(hexToRgb('#0f0f14')).toEqual([15, 15, 20])
    expect(hexToRgb('#ffffff')).toEqual([255, 255, 255])

    const rgb: [number, number, number] = [200, 100, 50]
    expect(hexToRgb(rgbToHex(rgb))).toEqual(rgb)
  })
})

describe('percentToTintStrength / tintStrengthToPercent', () => {
  it('把 0-100 的滑块百分比换算成 0..1 的 tintStrength', () => {
    expect(percentToTintStrength(0)).toBe(0)
    expect(percentToTintStrength(100)).toBe(1)
    expect(percentToTintStrength(40)).toBeCloseTo(0.4)
  })

  it('把 0..1 的 tintStrength 换算回 0-100 的整数百分比', () => {
    expect(tintStrengthToPercent(0)).toBe(0)
    expect(tintStrengthToPercent(1)).toBe(100)
    expect(tintStrengthToPercent(0.4)).toBe(40)
  })

  it('越界输入被夹到合法范围，不产生越界的 PATCH body', () => {
    expect(percentToTintStrength(-10)).toBe(0)
    expect(percentToTintStrength(150)).toBe(1)
    expect(tintStrengthToPercent(-0.5)).toBe(0)
    expect(tintStrengthToPercent(1.5)).toBe(100)
  })

  it('round-trip：滑块百分比 -> tintStrength -> 滑块百分比 还原成同一个整数', () => {
    for (const percent of [0, 1, 40, 63, 100]) {
      expect(tintStrengthToPercent(percentToTintStrength(percent))).toBe(percent)
    }
  })
})

// ─── 非有限值：Math.min/Math.max 夹不住 NaN ──────────────────────────────────
// 上面那些夹取测试很容易让人以为「输出一定落在 [0,1]」，但 Math 的夹取对 NaN 是透明的：
// Math.min(1, Math.max(0, NaN)) === NaN。NaN 走到 PATCH body 会被 JSON.stringify 变成
// null，服务端 400 拒掉，表现为「改了没保存上」且没有任何提示。当前调用方是原生控件、
// 吐不出 NaN，这几条钉的是函数自身的全域性
describe('themeControls: 非有限输入', () => {
  it.each([NaN, Infinity, -Infinity])('percentToTintStrength(%p) 落到 0 而不是 NaN', (v) => {
    expect(percentToTintStrength(v)).toBe(0)
  })

  it.each([NaN, Infinity, -Infinity])('tintStrengthToPercent(%p) 落到 0 而不是 NaN', (v) => {
    expect(tintStrengthToPercent(v)).toBe(0)
  })

  it('hexToRgb 对非法 hex 不产出 NaN', () => {
    expect(hexToRgb('#zzzzzz')).toEqual([0, 0, 0])
    expect(hexToRgb('#')).toEqual([0, 0, 0])
  })
})
