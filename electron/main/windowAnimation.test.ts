import { describe, it, expect } from 'vitest'
import { evaluateAnimationGuards, computeOffsetStartRect, interpolateFrame } from './windowAnimation'

// 只测 animateTo 里的纯函数部分（守卫判断、偏移起点、插值）。animateTo 本体依赖真实
// BrowserWindow/screen（setBounds/setOpacity 时序、中断监听、isAnimating 单飞状态），需要
// 真实 Electron 运行时才能验证，这里不测——跟 windowPositions.test.ts 只测纯函数同一个约定

describe('evaluateAnimationGuards', () => {
  it('flags sameDisplay when start and target come from the same display id', () => {
    expect(evaluateAnimationGuards(1, 1)).toEqual({ sameDisplay: true })
  })

  it('does not flag sameDisplay when start and target come from different display ids', () => {
    expect(evaluateAnimationGuards(1, 2)).toEqual({ sameDisplay: false })
  })
})

describe('computeOffsetStartRect', () => {
  // 工作区上下都留足空间：默认从上方滑入
  const roomy = { x: 0, y: 0, width: 1920, height: 1080 }

  it('keeps width/height identical to target and only offsets y', () => {
    const target = { x: 1920, y: 100, width: 300, height: 500 }
    const start = computeOffsetStartRect(target, roomy)
    expect(start.width).toBe(target.width)
    expect(start.height).toBe(target.height)
    expect(start.x).toBe(target.x)
    expect(start.y).toBe(target.y - 24)
  })

  // 起点必须留在工作区内：滑出屏外会变成「窗口先消失一下再滑回来」，比不做动画更糟
  it('slides in from below when the window is flush against the top of the work area', () => {
    const target = { x: 0, y: 0, width: 300, height: 500 }
    const start = computeOffsetStartRect(target, roomy)
    expect(start.y).toBe(24)
  })

  it('respects a work area whose origin is not zero (taskbar docked top)', () => {
    const workArea = { x: 0, y: 48, width: 1920, height: 1032 }
    const target = { x: 0, y: 48, width: 300, height: 500 }
    const start = computeOffsetStartRect(target, workArea)
    expect(start.y).toBe(72)
  })

  it('falls back to no offset when the window fills the work area vertically', () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 500 }
    const target = { x: 0, y: 0, width: 300, height: 500 }
    const start = computeOffsetStartRect(target, workArea)
    expect(start.y).toBe(target.y)
  })
})

describe('interpolateFrame', () => {
  const from = { x: 100, y: 76, width: 300, height: 500 }
  const to = { x: 100, y: 100, width: 300, height: 500 }

  it('lands exactly on the target position with opacity 1 at t=1 (final-state contract)', () => {
    expect(interpolateFrame(from, to, 1)).toEqual({ x: to.x, y: to.y, opacity: 1 })
  })

  it('starts exactly at the offset position with opacity 0 at t=0', () => {
    expect(interpolateFrame(from, to, 0)).toEqual({ x: from.x, y: from.y, opacity: 0 })
  })

  it('eases out (decelerates) rather than moving linearly midway through', () => {
    const mid = interpolateFrame(from, to, 0.5)
    // ease-out at t=0.5 is 0.75, i.e. already 75% of the way there, not 50%
    expect(mid.opacity).toBeCloseTo(0.75, 5)
  })

  it('clamps t values outside [0,1] instead of overshooting', () => {
    expect(interpolateFrame(from, to, 1.5)).toEqual({ x: to.x, y: to.y, opacity: 1 })
    expect(interpolateFrame(from, to, -0.5)).toEqual({ x: from.x, y: from.y, opacity: 0 })
  })
})
