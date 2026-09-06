import { describe, it, expect } from 'vitest'
import { evaluateAnimationGuards } from './windowAnimation'

// 只测 animateTo 里两条前置守卫的纯判断部分（见 evaluateAnimationGuards 注释）。animateTo
// 本体依赖真实 BrowserWindow/screen（补间、中断监听、isAnimating 单飞状态），需要真实
// Electron 运行时才能验证，这里不测——跟 windowPositions.test.ts 只测纯函数同一个约定

describe('evaluateAnimationGuards', () => {
  it('flags sameDisplay when start and target come from the same display id', () => {
    const start = { x: 0, y: 0, width: 300, height: 500 }
    const target = { x: 100, y: 100, width: 300, height: 500 }
    expect(evaluateAnimationGuards(start, target, 1, 1)).toEqual({ sameDisplay: true, sizeChanged: false })
  })

  it('does not flag sizeChanged for a size difference within the 2px drift tolerance', () => {
    const start = { x: 0, y: 0, width: 300, height: 500 }
    const target = { x: 1920, y: 0, width: 301, height: 501 }
    expect(evaluateAnimationGuards(start, target, 1, 2)).toEqual({ sameDisplay: false, sizeChanged: false })
  })

  it('flags sizeChanged once the difference exceeds the 2px drift tolerance', () => {
    const start = { x: 0, y: 0, width: 300, height: 500 }
    const target = { x: 1920, y: 0, width: 303, height: 500 }
    expect(evaluateAnimationGuards(start, target, 1, 2)).toEqual({ sameDisplay: false, sizeChanged: true })
  })

  it('flags sizeChanged for a genuine cross-display resize (e.g. differing scale factors)', () => {
    // computeDefaultBoundsForDisplay rescales width/height when the two displays' scale
    // factors differ by more than 20% (SCALE_DIFF_RATIO_THRESHOLD) -- this is the residual
    // case where sizeChanged legitimately fires on every dodge/restore between that pair
    const start = { x: 0, y: 0, width: 300, height: 500 }
    const target = { x: 1920, y: 0, width: 450, height: 750 }
    expect(evaluateAnimationGuards(start, target, 1, 2)).toEqual({ sameDisplay: false, sizeChanged: true })
  })

  it('can flag both guards at once (same display, but a genuine resize requested)', () => {
    const start = { x: 0, y: 0, width: 300, height: 500 }
    const target = { x: 0, y: 0, width: 500, height: 500 }
    expect(evaluateAnimationGuards(start, target, 1, 1)).toEqual({ sameDisplay: true, sizeChanged: true })
  })
})
