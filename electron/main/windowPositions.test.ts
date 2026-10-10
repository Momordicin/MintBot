import { describe, it, expect } from 'vitest'
import {
  pickLargestDisplay,
  resolveStartupDisplay,
  clampBoundsToWorkArea,
  pickFinestDisplay,
  computeSizeForDisplay,
  computeDefaultBoundsForDisplay,
  computeAnchoredResizeBounds,
  OVERLAY_DEFAULT_RIGHT_OFFSET_DIP,
  OVERLAY_DEFAULT_BOTTOM_OFFSET_DIP,
} from './windowPositions'

// 只测新增的纯函数（显示器挑选 + bounds 夹紧）。getPreferredBounds/setPreferredBounds/
// getPreferredDisplayId/commitUserChosenHomeDisplay 依赖 electron 的 app.getPath，需要真实
// Electron 运行时才能验证磁盘读写，这里不测（见任务说明：需要真实 BrowserWindow/screen
// 的部分不在这个测试文件覆盖范围内）。commitUserChosenHomeDisplay 的 import 边界守卫见
// windowPositionsCommitGuard.test.ts

function makeDisplay(
  id: number,
  bounds: Electron.Rectangle,
  workArea?: Electron.Rectangle,
  scaleFactor = 1
): Electron.Display {
  return {
    id,
    bounds,
    workArea: workArea ?? bounds,
    scaleFactor,
  } as unknown as Electron.Display
}

describe('pickLargestDisplay', () => {
  it('picks the display with the largest physical area', () => {
    const small = makeDisplay(1, { x: 0, y: 0, width: 1920, height: 1080 })
    const large = makeDisplay(2, { x: 1920, y: 0, width: 3840, height: 2160 })
    expect(pickLargestDisplay([small, large]).id).toBe(2)
    expect(pickLargestDisplay([large, small]).id).toBe(2)
  })

  it('is not fooled by workArea, only bounds matters', () => {
    // 较小的物理分辨率，但 workArea 因为任务栏更薄反而显得更大——挑选逻辑必须看 bounds
    const physicallySmaller = makeDisplay(
      1,
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 0, y: 0, width: 1920, height: 1070 }
    )
    const physicallyLarger = makeDisplay(
      2,
      { x: 1920, y: 0, width: 2560, height: 1440 },
      { x: 1920, y: 0, width: 2560, height: 1000 }
    )
    expect(pickLargestDisplay([physicallySmaller, physicallyLarger]).id).toBe(2)
  })

  it('returns the only display when there is exactly one', () => {
    const only = makeDisplay(1, { x: 0, y: 0, width: 1280, height: 720 })
    expect(pickLargestDisplay([only]).id).toBe(1)
  })
})

describe('resolveStartupDisplay', () => {
  const a = makeDisplay(1, { x: 0, y: 0, width: 1920, height: 1080 })
  const b = makeDisplay(2, { x: 1920, y: 0, width: 3840, height: 2160 })

  it('falls back to the largest display on first launch (lastDisplayId === null)', () => {
    expect(resolveStartupDisplay([a, b], null).id).toBe(2)
  })

  it('uses the remembered display when it is still connected', () => {
    expect(resolveStartupDisplay([a, b], 1).id).toBe(1)
  })

  it('falls back to the largest display when the remembered id is no longer connected', () => {
    expect(resolveStartupDisplay([a, b], 999).id).toBe(2)
  })
})

describe('clampBoundsToWorkArea', () => {
  const workArea = { x: 100, y: 50, width: 1000, height: 800 }

  it('leaves bounds untouched when they already fit', () => {
    const bounds = { x: 200, y: 100, width: 290, height: 520 }
    expect(clampBoundsToWorkArea(bounds, workArea)).toEqual(bounds)
  })

  it('clamps a bounds hanging off the top-left back into the work area', () => {
    const bounds = { x: -50, y: -20, width: 290, height: 520 }
    expect(clampBoundsToWorkArea(bounds, workArea)).toEqual({ x: 100, y: 50, width: 290, height: 520 })
  })

  it('clamps a bounds hanging off the bottom-right back into the work area', () => {
    const bounds = { x: 900, y: 700, width: 290, height: 520 }
    expect(clampBoundsToWorkArea(bounds, workArea)).toEqual({ x: 810, y: 330, width: 290, height: 520 })
  })

  it('shrinks a bounds larger than the work area and pins it to the origin', () => {
    const bounds = { x: 500, y: 400, width: 1200, height: 900 }
    expect(clampBoundsToWorkArea(bounds, workArea)).toEqual({ x: 100, y: 50, width: 1000, height: 800 })
  })

  it('carries a non-zero work area offset (taskbar docked top/left) through unchanged bounds', () => {
    const offsetWorkArea = { x: 0, y: 40, width: 1920, height: 1040 }
    const bounds = { x: 10, y: 40, width: 132, height: 132 }
    expect(clampBoundsToWorkArea(bounds, offsetWorkArea)).toEqual(bounds)
  })
})

// 密度指标 = bounds（DIP）× scaleFactor 换算出的物理像素宽高相乘（见 windowPositions.ts
// physicalPixelArea 注释）。这里的测试用例刻意跟真实产品尺寸（290×520/132×132）解耦，
// 用简单整数验证换算规则本身，不依赖 index.ts 里的默认值常量
describe('pickFinestDisplay', () => {
  it('picks the display with the most physical pixels when resolutions match but scaleFactor differs', () => {
    const coarse = makeDisplay(1, { x: 0, y: 0, width: 1920, height: 1080 }, undefined, 1)
    const fine = makeDisplay(2, { x: 1920, y: 0, width: 1920, height: 1080 }, undefined, 2)
    expect(pickFinestDisplay([coarse, fine]).id).toBe(2)
    expect(pickFinestDisplay([fine, coarse]).id).toBe(2)
  })

  it('picks the display with the most physical pixels when scaleFactor matches but resolution differs', () => {
    const small = makeDisplay(1, { x: 0, y: 0, width: 1280, height: 720 }, undefined, 1)
    const large = makeDisplay(2, { x: 1280, y: 0, width: 3840, height: 2160 }, undefined, 1)
    expect(pickFinestDisplay([small, large]).id).toBe(2)
  })

  it('returns the only display when there is exactly one', () => {
    const only = makeDisplay(1, { x: 0, y: 0, width: 1920, height: 1080 }, undefined, 1)
    expect(pickFinestDisplay([only]).id).toBe(1)
  })
})

describe('computeSizeForDisplay', () => {
  const defaultSize = { width: 300, height: 600 }

  it('uses the default size unchanged for every display when no pair differs by more than 20%', () => {
    // (2359296 - 2073600) / 2073600 ≈ 13.8%, under the threshold
    const a = makeDisplay(1, { x: 0, y: 0, width: 1920, height: 1080 }, undefined, 1)
    const b = makeDisplay(2, { x: 1920, y: 0, width: 2048, height: 1152 }, undefined, 1)
    expect(computeSizeForDisplay(a, [a, b], defaultSize)).toEqual(defaultSize)
    expect(computeSizeForDisplay(b, [a, b], defaultSize)).toEqual(defaultSize)
  })

  it('gives the anchor (finest) display exactly the default size once any pair exceeds 20%', () => {
    const anchor = makeDisplay(1, { x: 0, y: 0, width: 1920, height: 1080 }, undefined, 2)
    const other = makeDisplay(2, { x: 1920, y: 0, width: 1920, height: 1080 }, undefined, 1)
    expect(computeSizeForDisplay(anchor, [anchor, other], defaultSize)).toEqual(defaultSize)
  })

  it('scales a coarser display down from the anchor using sqrt(density ratio), matching the old scaleFactor-ratio result when resolutions are equal', () => {
    // Same bounds, scaleFactor 2 vs 1 -> area ratio is 4 (2^2), sqrt back to a linear ratio of 0.5 --
    // identical to what the old per-pair scaleFactor-ratio implementation produced for this case
    const anchor = makeDisplay(1, { x: 0, y: 0, width: 1920, height: 1080 }, undefined, 2)
    const other = makeDisplay(2, { x: 1920, y: 0, width: 1920, height: 1080 }, undefined, 1)
    expect(computeSizeForDisplay(other, [anchor, other], defaultSize)).toEqual({ width: 150, height: 300 })
  })

  it('scales a coarser display down from the anchor using a genuine physical-resolution difference (not just scaleFactor)', () => {
    // 3840x2160 vs 1280x720 at the same scaleFactor -> area ratio 9, sqrt -> linear ratio 1/3
    const anchor = makeDisplay(1, { x: 0, y: 0, width: 3840, height: 2160 }, undefined, 1)
    const other = makeDisplay(2, { x: 3840, y: 0, width: 1280, height: 720 }, undefined, 1)
    expect(computeSizeForDisplay(other, [anchor, other], defaultSize)).toEqual({ width: 100, height: 200 })
  })

  it('is history-independent: the same display resolves to the same size regardless of array order or which other display is present', () => {
    const anchor = makeDisplay(1, { x: 0, y: 0, width: 1920, height: 1080 }, undefined, 2)
    const target = makeDisplay(2, { x: 1920, y: 0, width: 1920, height: 1080 }, undefined, 1)
    const third = makeDisplay(3, { x: 3840, y: 0, width: 1920, height: 1080 }, undefined, 2)

    const viaOrderOne = computeSizeForDisplay(target, [anchor, target, third], defaultSize)
    const viaOrderTwo = computeSizeForDisplay(target, [third, target, anchor], defaultSize)
    const viaOrderThree = computeSizeForDisplay(target, [target, anchor, third], defaultSize)

    expect(viaOrderOne).toEqual({ width: 150, height: 300 })
    expect(viaOrderTwo).toEqual(viaOrderOne)
    expect(viaOrderThree).toEqual(viaOrderOne)
  })

  it('treats a single connected display as homogeneous (no pair to compare)', () => {
    const only = makeDisplay(1, { x: 0, y: 0, width: 1920, height: 1080 }, undefined, 3)
    expect(computeSizeForDisplay(only, [only], defaultSize)).toEqual(defaultSize)
  })
})

describe('computeDefaultBoundsForDisplay', () => {
  it('applies density-scaled size and centers the chat window in a non-zero-origin work area', () => {
    const anchor = makeDisplay(1, { x: 0, y: 0, width: 1920, height: 1080 }, undefined, 2)
    const other = makeDisplay(
      2,
      { x: 1920, y: 0, width: 1920, height: 1080 },
      { x: 1920, y: 40, width: 1920, height: 1040 },
      1
    )
    const defaultSize = { width: 300, height: 600 }
    expect(computeDefaultBoundsForDisplay(other, [anchor, other], defaultSize, 'chat')).toEqual({
      x: 1920 + (1920 - 150) / 2,
      y: 40 + (1040 - 300) / 2,
      width: 150,
      height: 300,
    })
  })

  it('keeps a chat window larger than the work area inside the work area', () => {
    const display = makeDisplay(1, { x: 0, y: 0, width: 800, height: 600 }, { x: 0, y: 0, width: 800, height: 560 })
    const defaultSize = { width: 1000, height: 800 }
    expect(computeDefaultBoundsForDisplay(display, [display], defaultSize, 'chat')).toEqual({ x: 0, y: 0, width: 800, height: 560 })
  })

  it('places the overlay bottom-right, 50 DIP from the right edge and 100 DIP above the work-area bottom', () => {
    const display = makeDisplay(1, { x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1040 })
    const defaultSize = { width: 132, height: 132 }
    expect(computeDefaultBoundsForDisplay(display, [display], defaultSize, 'overlay')).toEqual({
      x: 1920 - 132 - OVERLAY_DEFAULT_RIGHT_OFFSET_DIP,
      y: 1040 - 132 - OVERLAY_DEFAULT_BOTTOM_OFFSET_DIP,
      width: 132,
      height: 132,
    })
    expect(OVERLAY_DEFAULT_RIGHT_OFFSET_DIP).toBe(50)
    expect(OVERLAY_DEFAULT_BOTTOM_OFFSET_DIP).toBe(100)
  })

  it('offsets the overlay from a non-zero work-area origin and applies density-scaled size on a secondary display', () => {
    const anchor = makeDisplay(1, { x: 0, y: 0, width: 1920, height: 1080 }, undefined, 2)
    const other = makeDisplay(
      2,
      { x: 1920, y: 0, width: 1920, height: 1080 },
      { x: 2000, y: 40, width: 1840, height: 1040 },
      1
    )
    expect(computeDefaultBoundsForDisplay(other, [anchor, other], { width: 132, height: 132 }, 'overlay')).toEqual({
      x: 2000 + 1840 - 66 - 50,
      y: 40 + 1040 - 66 - 100,
      width: 66,
      height: 66,
    })
  })

  it('clamps the overlay inside a tiny work area so it never leaves the top-left', () => {
    const display = makeDisplay(1, { x: 0, y: 0, width: 150, height: 150 }, { x: 10, y: 20, width: 150, height: 150 })
    expect(computeDefaultBoundsForDisplay(display, [display], { width: 132, height: 132 }, 'overlay')).toEqual({
      x: 10,
      y: 20,
      width: 132,
      height: 132,
    })
  })

  it('centers the chat window in a plain work area', () => {
    const display = makeDisplay(1, { x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1040 })
    expect(computeDefaultBoundsForDisplay(display, [display], { width: 290, height: 520 }, 'chat')).toEqual({
      x: 815,
      y: 260,
      width: 290,
      height: 520,
    })
  })
})

describe('computeAnchoredResizeBounds', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 }

  it('keeps the bottom edge and the horizontal center when growing', () => {
    expect(computeAnchoredResizeBounds({ x: 1000, y: 800, width: 132, height: 132 }, { width: 300, height: 500 }, workArea)).toEqual({
      x: 916,
      y: 432,
      width: 300,
      height: 500,
    })
  })

  it('keeps the bottom edge and the horizontal center when shrinking', () => {
    expect(computeAnchoredResizeBounds({ x: 900, y: 500, width: 300, height: 500 }, { width: 132, height: 132 }, workArea)).toEqual({
      x: 984,
      y: 868,
      width: 132,
      height: 132,
    })
  })

  it('returns the same bounds when the size does not change', () => {
    const bounds = { x: 300, y: 400, width: 132, height: 132 }
    expect(computeAnchoredResizeBounds(bounds, { width: 132, height: 132 }, workArea)).toEqual(bounds)
  })

  it('pulls the window back inside the work area when growing would overflow it', () => {
    expect(computeAnchoredResizeBounds({ x: 1850, y: 900, width: 132, height: 132 }, { width: 300, height: 500 }, workArea)).toEqual({
      x: 1620,
      y: 532,
      width: 300,
      height: 500,
    })
    expect(computeAnchoredResizeBounds({ x: 10, y: 20, width: 132, height: 132 }, { width: 300, height: 500 }, { x: 0, y: 0, width: 1920, height: 1040 })).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 500,
    })
  })

  it('never exceeds the work area size', () => {
    expect(computeAnchoredResizeBounds({ x: 0, y: 0, width: 132, height: 132 }, { width: 3000, height: 2000 }, workArea)).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1040,
    })
  })

  it('restores an edge-docked window at the new width: widening re-centers and stays inside the work area', () => {
    const secondary = { x: 1920, y: 0, width: 1920, height: 1040 }
    expect(computeAnchoredResizeBounds({ x: 3708, y: 900, width: 132, height: 132 }, { width: 300, height: 500 }, secondary)).toEqual({
      x: 3540,
      y: 532,
      width: 300,
      height: 500,
    })
    expect(computeAnchoredResizeBounds({ x: 1000, y: 900, width: 132, height: 132 }, { width: 300, height: 500 }, workArea)).toEqual({
      x: 916,
      y: 532,
      width: 300,
      height: 500,
    })
  })

  it('restores an edge-docked window at the new width: narrowing re-centers and stays inside the work area', () => {
    expect(computeAnchoredResizeBounds({ x: 1620, y: 532, width: 300, height: 500 }, { width: 132, height: 132 }, workArea)).toEqual({
      x: 1704,
      y: 900,
      width: 132,
      height: 132,
    })
    expect(computeAnchoredResizeBounds({ x: 0, y: 532, width: 300, height: 500 }, { width: 132, height: 132 }, workArea)).toEqual({
      x: 84,
      y: 900,
      width: 132,
      height: 132,
    })
  })
})
