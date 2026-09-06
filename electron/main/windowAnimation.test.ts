import { describe, it, expect } from 'vitest'
import {
  evaluateAnimationGuards,
  computeOffsetStartRect,
  interpolateFrame,
  easeEntrance
} from './windowAnimation'

// 只测 animateTo 里的纯函数部分（守卫判断、偏移起点、插值、两条缓动曲线）。animateTo 本体
// 依赖真实 BrowserWindow/screen（setBounds/setOpacity 时序、中断监听、isAnimating 单飞状态、
// 划出/瞬移/划入三段的衔接），需要真实 Electron 运行时才能验证，这里不测——跟
// windowPositions.test.ts 只测纯函数同一个约定

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
  // 位置/进度插值本身与具体缓动曲线无关，这里用恒等函数把"插值算术是否正确"跟"缓动曲线
  // 本身是否正确"（下面两个 describe 块）分开验证
  const identity = (p: number): number => p

  it('lands exactly on the target position with progress 1 at t=1 (final-state contract)', () => {
    expect(interpolateFrame(from, to, 1, identity)).toEqual({ x: to.x, y: to.y, opacity: 1 })
  })

  it('starts exactly at the from position with progress 0 at t=0', () => {
    expect(interpolateFrame(from, to, 0, identity)).toEqual({ x: from.x, y: from.y, opacity: 0 })
  })

  it('applies the given easing function to both position and the returned progress value', () => {
    const halfway = (p: number): number => (p === 0.5 ? 0.75 : p)
    const mid = interpolateFrame(from, to, 0.5, halfway)
    expect(mid.opacity).toBeCloseTo(0.75, 5)
    expect(mid.y).toBe(Math.round(from.y + (to.y - from.y) * 0.75))
  })

  it('clamps t values outside [0,1] instead of overshooting', () => {
    expect(interpolateFrame(from, to, 1.5, identity)).toEqual({ x: to.x, y: to.y, opacity: 1 })
    expect(interpolateFrame(from, to, -0.5, identity)).toEqual({ x: from.x, y: from.y, opacity: 0 })
  })
})

// 参考实现：不依赖 easeEntrance 内部的闭式解推导，独立用二分法反解任意三次贝塞尔曲线的
// x(s) = p，供下面的测试核对 easeEntrance 的闭式解本身没有推导错
function referenceBezierEase(p1x: number, p2x: number): (p: number) => number {
  const x = (s: number): number => {
    const oneMinusS = 1 - s
    return 3 * oneMinusS * oneMinusS * s * p1x + 3 * oneMinusS * s * s * p2x + s * s * s
  }
  return (p: number): number => {
    const clamped = Math.min(Math.max(p, 0), 1)
    let lo = 0
    let hi = 1
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2
      if (x(mid) < clamped) lo = mid
      else hi = mid
    }
    const s = (lo + hi) / 2
    return s * s * (3 - 2 * s)
  }
}

describe('easeEntrance (cubic-bezier(0, 0, 0, 1))', () => {
  it('starts at 0 and ends at 1', () => {
    expect(easeEntrance(0)).toBe(0)
    expect(easeEntrance(1)).toBe(1)
  })

  it('is monotonically non-decreasing across a full sweep', () => {
    let previous = -Infinity
    for (let i = 0; i <= 100; i++) {
      const current = easeEntrance(i / 100)
      expect(current).toBeGreaterThanOrEqual(previous)
      previous = current
    }
  })

  it('matches a numerically-inverted reference implementation (guards the closed form against drift)', () => {
    const reference = referenceBezierEase(0, 0)
    for (let i = 0; i <= 20; i++) {
      const p = i / 20
      expect(easeEntrance(p)).toBeCloseTo(reference(p), 5)
    }
  })

  it('decelerates: is already more than halfway done by the midpoint in time', () => {
    expect(easeEntrance(0.5)).toBeGreaterThan(0.5)
  })
})

// easeExit（此前 cubic-bezier(0.3, 0, 1, 1) 的独立加速曲线，含牛顿迭代/二分法数值反解）
// 已随划出段改用 easeEntrance 一起移除——划出段现在与划入段共用同一条曲线，上面的
// easeEntrance 测试块已经覆盖它
