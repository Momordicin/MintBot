import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// animateTo 依赖真实 BrowserWindow/screen（setBounds/setOpacity 时序、中断监听、isAnimating
// 单飞状态、各条路径的衔接）——跟 windowBehavior.test.ts 同一个约定，用 vi.mock('electron', ...)
// 换一份假的 screen（只需要 getDisplayMatching，animateTo 不在运行时引用 BrowserWindow 本身，
// 只用它做类型标注），供下面 describe('animateTo', ...) 驱动整段动画逻辑（instant 分支、
// 同屏补间、跨屏三段式、取消）。纯函数部分（守卫判断、偏移起点、插值、缓动曲线）不需要这份
// mock，跟此前一样直接调用
const testState = vi.hoisted(() => ({
  // bounds -> { id, workArea } 的映射，按测试各自需要覆盖。默认单显示器，永远命中同一块屏。
  displayForBounds: (_bounds: { x: number; y: number; width: number; height: number }) => ({
    id: 1,
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  }),
}))

vi.mock('electron', () => ({
  screen: {
    getDisplayMatching: (bounds: { x: number; y: number; width: number; height: number }) =>
      testState.displayForBounds(bounds),
  },
  BrowserWindow: class {},
}))

import {
  evaluateAnimationGuards,
  computeOffsetStartRect,
  interpolateFrame,
  interpolateRect,
  easeEntrance,
  animateTo,
  SAME_DISPLAY_TWEEN_DURATION_MS,
} from './windowAnimation'

// 供 animateTo 测试使用的假窗口：只实现 animateTo 实际会调用的那几个方法，行为足够真实
// （setBounds/setOpacity 真的更新内部状态，getBounds 读回最新值）以驱动整段逻辑，但不是
// 真实 BrowserWindow——跟 windowBehavior.test.ts 的 makeFakeOverlayWindow 同一个约定
function makeFakeWindow(initialBounds: Electron.Rectangle) {
  let bounds = initialBounds
  let opacity = 1
  let destroyed = false
  const listeners = new Map<string, () => void>()
  return {
    getBounds: () => bounds,
    setBounds: vi.fn((b: Electron.Rectangle) => {
      bounds = b
    }),
    setOpacity: vi.fn((o: number) => {
      opacity = o
    }),
    getOpacity: () => opacity,
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true
    },
    // animateTo 注册 4 个一次性中断监听（minimize/hide/close/closed）。这里**真的**记住它们
    // 并提供 emit()：中断路径与三个逐帧 isDestroyed 分支此前完全没有测试走到过，而那正是
    // 「onComplete 在每一条终结路径上恰好触发一次」这条契约最容易被漏掉的地方——曾经就漏了
    // 五处中的三处，却被注释声称已收口
    once: vi.fn((event: string, handler: () => void) => {
      listeners.set(event, handler)
    }),
    off: vi.fn((event: string) => {
      listeners.delete(event)
    }),
    emit: (event: string) => {
      listeners.get(event)?.()
    },
  }
}

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

describe('interpolateRect', () => {
  const from = { x: 0, y: 0, width: 132, height: 132 }
  const to = { x: -92, y: 0, width: 132, height: 132 }
  const identity = (p: number): number => p

  it('starts exactly at from (all four fields) at t=0', () => {
    expect(interpolateRect(from, to, 0, identity)).toEqual(from)
  })

  it('lands exactly on to (all four fields) at t=1 — the final-state contract the tween relies on', () => {
    expect(interpolateRect(from, to, 1, identity)).toEqual(to)
  })

  it('interpolates width/height too, not just x/y', () => {
    const wideTo = { x: 0, y: 0, width: 300, height: 520 }
    const mid = interpolateRect(from, wideTo, 0.5, identity)
    expect(mid.width).toBe(Math.round(from.width + (wideTo.width - from.width) * 0.5))
    expect(mid.height).toBe(Math.round(from.height + (wideTo.height - from.height) * 0.5))
  })

  it('clamps t values outside [0,1] instead of overshooting', () => {
    expect(interpolateRect(from, to, 1.5, identity)).toEqual(to)
    expect(interpolateRect(from, to, -0.5, identity)).toEqual(from)
  })
})

// animateTo：本次改动的核心——instant 分支、同屏补间、跨屏三段式（不变）、取消。见文件顶部
// 关于 vi.mock('electron', ...) 的说明
describe('animateTo — the isDestroyed early return is a terminal path', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // 回归钉子：这条路径此前直接 return、不调用 onComplete，等于违反本模块「onComplete 在每一条
  // 终结路径上恰好触发一次」的契约。后果不是少一次回调那么轻——调用方
  // （windowBehavior.ts beginProgrammaticMove）的「程序化移动进行中」括号永远不会释放，
  // 该窗口的 persistBoundsNow 从此被永久压制，与上一轮刚修掉的卡死是同一类
  it('fires onComplete exactly once and returns a safe no-op cancel', () => {
    const win = makeFakeWindow({ x: 0, y: 0, width: 132, height: 132 })
    win.destroy()
    const onComplete = vi.fn()

    const cancel = animateTo(
      win as unknown as Electron.BrowserWindow,
      { x: 500, y: 0, width: 132, height: 132 },
      onComplete
    )

    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(win.setBounds).not.toHaveBeenCalled()

    cancel()
    cancel()
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  // 同一个缺陷的第二个入口：snap() 自己也有一条 isDestroyed 早返回（四类中断事件、跨调用
  // 取消、异常兜底的共同出口）。窗口在动画进行中被销毁时走的是它，不是函数入口那条
  // 逐帧 isDestroyed 分支：窗口在动画跑起来之后才被销毁，走的既不是函数入口那条检查、
  // 也不是 snap()，而是 tweenFrame/exitFrame/entranceFrame 各自的那一条
  it('a window destroyed mid-flight still fires onComplete exactly once (per-frame guard)', () => {
    const win = makeFakeWindow({ x: 0, y: 0, width: 132, height: 132 })
    const onComplete = vi.fn()
    animateTo(win as unknown as Electron.BrowserWindow, { x: 60, y: 0, width: 132, height: 132 }, onComplete)
    expect(onComplete).not.toHaveBeenCalled()

    // 销毁但**不**触发任何中断监听，强制下一帧走逐帧守卫那条路径
    win.destroy()
    vi.advanceTimersByTime(50) // 跨过至少一帧（windowAnimation.ts 的 FRAME_MS = 16，未导出）

    expect(onComplete).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  // 中断派发路径：animateTo 注册 minimize/hide/close/closed 四个一次性监听，命中走
  // onInterrupt -> snap()。这条路径此前没有任何测试走到过——假窗口的 once/off 是空壳，
  // 根本不保存处理器。emit() 就是为了补上它而加的，所以必须真的有测试调用它，否则只是
  // 把「没覆盖」换了个写法
  it('an interrupt event (closed) mid-flight fires onComplete exactly once', () => {
    const win = makeFakeWindow({ x: 0, y: 0, width: 132, height: 132 })
    const onComplete = vi.fn()
    animateTo(win as unknown as Electron.BrowserWindow, { x: 60, y: 0, width: 132, height: 132 }, onComplete)
    expect(onComplete).not.toHaveBeenCalled()

    win.emit('closed')

    expect(onComplete).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  // 跨屏三段式的逐帧守卫（exitFrame / entranceFrame）与同屏 tweenFrame 是结构相同的三份
  // 拷贝，此前只有 tweenFrame 那份有回归测试。这条覆盖跨屏那两份
  it('a window destroyed mid-flight during a cross-display animation still fires onComplete exactly once', () => {
    testState.displayForBounds = (bounds) =>
      bounds.x < 1920
        ? { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }
        : { id: 2, workArea: { x: 1920, y: 0, width: 1920, height: 1080 } }

    const win = makeFakeWindow({ x: 100, y: 100, width: 300, height: 500 })
    const onComplete = vi.fn()
    animateTo(
      win as unknown as Electron.BrowserWindow,
      { x: 2020, y: 100, width: 300, height: 500 },
      onComplete
    )
    expect(onComplete).not.toHaveBeenCalled()

    // 销毁但不触发任何中断监听，强制下一帧走 exitFrame 自己的 isDestroyed 守卫
    win.destroy()
    vi.advanceTimersByTime(50)

    expect(onComplete).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('snap() on an already-destroyed window still fires onComplete exactly once', () => {
    const win = makeFakeWindow({ x: 0, y: 0, width: 132, height: 132 })
    const onComplete = vi.fn()
    const cancel = animateTo(
      win as unknown as Electron.BrowserWindow,
      { x: 500, y: 0, width: 132, height: 132 },
      onComplete
    )
    expect(onComplete).not.toHaveBeenCalled()

    win.destroy()
    cancel()

    expect(onComplete).toHaveBeenCalledTimes(1)
    cancel()
    expect(onComplete).toHaveBeenCalledTimes(1)
  })
})

describe('animateTo', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    testState.displayForBounds = () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('options.instant', () => {
    it('jumps straight to target with a single setBounds, no interpolation, onComplete exactly once', () => {
      const win = makeFakeWindow({ x: 0, y: 0, width: 132, height: 132 })
      const target = { x: -92, y: 0, width: 132, height: 132 }
      const onComplete = vi.fn()

      const cancel = animateTo(win as unknown as Electron.BrowserWindow, target, onComplete, { instant: true })

      expect(win.setBounds).toHaveBeenCalledTimes(1)
      expect(win.setBounds).toHaveBeenCalledWith(target)
      expect(win.setOpacity).toHaveBeenCalledWith(1)
      expect(onComplete).toHaveBeenCalledTimes(1)

      // No timer was scheduled for the instant path — advancing time must not do anything else,
      // and the returned cancel function must remain a safe no-op (mandatory "at most once"
      // contract, even on this path).
      vi.advanceTimersByTime(10_000)
      cancel()
      expect(win.setBounds).toHaveBeenCalledTimes(1)
      expect(onComplete).toHaveBeenCalledTimes(1)
    })
  })

  describe('same-display tween (sameDisplay=true, no options)', () => {
    it('interpolates through intermediate bounds, then lands exactly on target with onComplete exactly once', () => {
      const start = { x: 0, y: 0, width: 132, height: 132 }
      const target = { x: -92, y: 0, width: 132, height: 132 }
      const win = makeFakeWindow(start)
      const onComplete = vi.fn()

      const cancel = animateTo(win as unknown as Electron.BrowserWindow, target, onComplete)

      // Halfway through the tween: bounds must have moved off both start and target — this is
      // what distinguishes the tween from the instant path (single jump) and proves interpolation
      // is actually happening, not just a delayed snap.
      //
      // Fix 3 (third rework pass): strengthened from "not start, not target" to an exact match
      // against interpolateRect(start, target, t, easeEntrance) for the sampled t — the previous,
      // looser assertion would not have caught a wrong easing curve or a wrong interpolated axis
      // (e.g. width/height frozen instead of tracked, or x/y swapped). Math.floor(160/2)=80 is
      // exactly divisible by the tween's frame interval, so fake timers land exactly on t=0.5 with
      // no rounding slack to account for.
      vi.advanceTimersByTime(Math.floor(SAME_DISPLAY_TWEEN_DURATION_MS / 2))
      const midCall = win.setBounds.mock.calls.at(-1)?.[0] as Electron.Rectangle
      expect(midCall).toBeDefined()
      expect(midCall.x).not.toBe(start.x)
      expect(midCall.x).not.toBe(target.x)
      expect(midCall).toEqual(interpolateRect(start, target, 0.5, easeEntrance))
      // Opacity must stay at 1 throughout the same-display tween — it is a visible slide, not a
      // fade like the cross-display exit/entrance segments (see interpolateRect's own comment).
      expect(win.setOpacity).not.toHaveBeenCalled()
      expect(onComplete).not.toHaveBeenCalled()

      // Past the full duration: final frame must write target exactly (not an interpolated value)
      // and fire onComplete exactly once.
      vi.advanceTimersByTime(SAME_DISPLAY_TWEEN_DURATION_MS)
      expect(win.setBounds).toHaveBeenLastCalledWith(target)
      expect(win.setOpacity).toHaveBeenCalledWith(1)
      expect(onComplete).toHaveBeenCalledTimes(1)

      // Mandatory "at most once" contract: advancing further, or calling the returned cancel
      // function after natural completion, must not fire onComplete again — this is exactly the
      // scenario Fix B's cancelled flag guards (see animateTo's own header comment): the final
      // frame and the cancel path share the same guard, so a caller that keeps the returned
      // cancel function around and invokes it after the animation already finished must not get
      // a second onComplete call.
      vi.advanceTimersByTime(SAME_DISPLAY_TWEEN_DURATION_MS * 2)
      cancel()
      expect(onComplete).toHaveBeenCalledTimes(1)
    })

    it('still ends exactly at target and fires onComplete exactly once when cancelled mid-tween', () => {
      const start = { x: 0, y: 0, width: 132, height: 132 }
      const target = { x: -92, y: 0, width: 132, height: 132 }
      const win = makeFakeWindow(start)
      const onComplete = vi.fn()

      const cancel = animateTo(win as unknown as Electron.BrowserWindow, target, onComplete)

      vi.advanceTimersByTime(Math.floor(SAME_DISPLAY_TWEEN_DURATION_MS / 3))
      cancel()

      expect(win.setBounds).toHaveBeenLastCalledWith(target)
      expect(win.setOpacity).toHaveBeenLastCalledWith(1)
      expect(onComplete).toHaveBeenCalledTimes(1)

      // The tween's own timer must have been cleared by cancellation — advancing further, or
      // calling cancel() again, must not produce another frame or another onComplete call.
      const callsAfterCancel = win.setBounds.mock.calls.length
      vi.advanceTimersByTime(SAME_DISPLAY_TWEEN_DURATION_MS * 2)
      cancel()
      expect(win.setBounds).toHaveBeenCalledTimes(callsAfterCancel)
      expect(onComplete).toHaveBeenCalledTimes(1)
    })
  })

  describe('cross-display (sameDisplay=false): unchanged three-phase exit/teleport/entrance', () => {
    it('fades out, jumps displays invisibly, fades back in, and lands exactly on target with onComplete exactly once', () => {
      const start = { x: 100, y: 100, width: 300, height: 500 }
      const target = { x: 2020, y: 100, width: 300, height: 500 }
      testState.displayForBounds = (bounds) =>
        bounds.x < 1920
          ? { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }
          : { id: 2, workArea: { x: 1920, y: 0, width: 1920, height: 1080 } }

      const win = makeFakeWindow(start)
      const onComplete = vi.fn()

      animateTo(win as unknown as Electron.BrowserWindow, target, onComplete)

      // Full exit + teleport + entrance sequence in one go — this is what actually distinguishes
      // the three-phase shape from the same-display tween: the tween never touches opacity.
      vi.advanceTimersByTime(1000)

      expect(win.setOpacity.mock.calls.some(call => call[0] === 0)).toBe(true)
      expect(win.setBounds).toHaveBeenLastCalledWith(target)
      expect(win.getOpacity()).toBe(1)
      expect(onComplete).toHaveBeenCalledTimes(1)
    })
  })
})
