import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

// mock 掉 windowBehavior.ts 的全部依赖，端到端跑真实编排逻辑；只放纯函数层测不到的少量关键回归
// 范围约定（用户指示）：不测 Electron 调用次数、参数等实现细节；新用例先考虑放进 desktopPresence.ts / displayStateMap.ts 的纯函数测试

const testState = vi.hoisted(() => ({
  displays: [] as Array<{
    id: number
    bounds: { x: number; y: number; width: number; height: number }
    workArea: { x: number; y: number; width: number; height: number }
    scaleFactor: number
  }>,
  homeDisplayId: 1,
  matchDisplay: (_bounds: unknown) => ({ id: 1 }) as { id: number },
  blockerMap: new Map<number, unknown>(),
  // 按窗口分别记录拖拽状态，让用例能独立驱动 overlay 与 chat
  dragging: { overlay: false, chat: false } as Record<'overlay' | 'chat', boolean>,
}))

const { revalidateBlockersNowMock, requestObservationMock, setPreferredBoundsMock, getPreferredBoundsMock } = vi.hoisted(() => ({
  revalidateBlockersNowMock: vi.fn(),
  requestObservationMock: vi.fn(),
  setPreferredBoundsMock: vi.fn(),
  getPreferredBoundsMock: vi.fn((): unknown => null),
}))

vi.mock('electron', () => ({
  screen: {
    getAllDisplays: () => testState.displays,
    getDisplayMatching: (bounds: unknown) => testState.matchDisplay(bounds),
  },
  BrowserWindow: class {},
}))

vi.mock('./windowPositions', async () => {
  const actual = await vi.importActual<typeof import('./windowPositions')>('./windowPositions')
  return {
    collapsedHandleBounds: actual.collapsedHandleBounds,
    petHandleBounds: actual.petHandleBounds,
    COLLAPSED_SIZE: actual.COLLAPSED_SIZE,
    expandedBoundsFromHandle: actual.expandedBoundsFromHandle,
    getPreferredBounds: getPreferredBoundsMock,
    petWindowBounds: actual.petWindowBounds,
    petPreferredFromWindow: actual.petPreferredFromWindow,
    setPreferredBounds: setPreferredBoundsMock,
    getEffectiveHomeDisplay: (displays: typeof testState.displays) => {
      const home = displays.find(d => d.id === testState.homeDisplayId)
      if (home) return home
      // home 已断开时回退到最大的显示器
      return displays.reduce((a, b) => (a.bounds.width * a.bounds.height >= b.bounds.width * b.bounds.height ? a : b))
    },
    computeDefaultBoundsForDisplay: (
      display: { bounds: { x: number; y: number } },
      _displays: unknown,
      size: { width: number; height: number }
    ) => ({
      x: display.bounds.x,
      y: display.bounds.y,
      width: size.width,
      height: size.height,
    }),
    DEFAULT_WINDOW_SIZE: { chat: { width: 290, height: 520 }, overlay: { width: 132, height: 132 } },
    // 必须与下方本文件的 PERSIST_DEBOUNCE_MS 保持一致
    PERSIST_DEBOUNCE_MS: 300,
  }
})

vi.mock('./homeDisplayCommit', () => ({
  commitHomeDisplayFromDragOutcome: vi.fn(),
}))

vi.mock('./foregroundWorldModel', () => ({
  getDisplayStateMap: () => testState.blockerMap,
  revalidateBlockersNow: revalidateBlockersNowMock,
  requestObservation: requestObservationMock,
}))

vi.mock('./windowAnimation', () => ({
  // 同步完成，并把 win.getBounds() 改成目标值，模拟 setBounds 已生效；否则落定后的收敛检查会一直读到旧位置、反复排队动画
  animateTo: vi.fn((win: { getBounds: () => unknown }, target: unknown, onComplete?: () => void) => {
    win.getBounds = () => target
    onComplete?.()
    return () => {}
  }),
}))

vi.mock('./chatReveal', () => ({
  revealChat: vi.fn((_win: unknown, show: () => void) => show()),
}))

vi.mock('./dragActivity', () => ({
  isWindowDragInProgress: (windowKey: 'overlay' | 'chat') => testState.dragging[windowKey],
  // 此处 testState.dragging 就是拖拽状态，置 false 即收掉松手尾巴
  endDragTail: (windowKey: 'overlay' | 'chat') => {
    testState.dragging[windowKey] = false
  },
}))

import { commitHomeDisplayFromDragOutcome } from './homeDisplayCommit'
import { animateTo } from './windowAnimation'
import {
  evaluateDesktopPresence,
  handleWindowMoved,
  markProgrammaticWindowPlacement,
  markTopologySettle,
  applyWindowBehaviorSnapshot,
  initWindowBehaviorConfig,
  getCachedWindowBehaviorConfig,
  requestOverlayEdgeHover,
  sendCurrentPetPresenceOnReady,
  closeStartupGate,
  openStartupGate,
  cancelProgrammaticMoveOnDragStart,
  applyOverlaySize,
  armPetSizeGate,
  prepareChatForShow,
} from './windowBehavior'

let testRevision = 0

async function settleConfigOnly(mod: { initWindowBehaviorConfig: typeof initWindowBehaviorConfig }): Promise<void> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
  try {
    await mod.initWindowBehaviorConfig(null, null)
  } finally {
    vi.unstubAllGlobals()
  }
}

async function settleWindowBehaviorConfig(
  mod: { initWindowBehaviorConfig: typeof initWindowBehaviorConfig; armPetSizeGate: typeof armPetSizeGate }
): Promise<void> {
  await settleConfigOnly(mod)
  const alreadyFake = vi.isFakeTimers()
  if (!alreadyFake) vi.useFakeTimers()
  mod.armPetSizeGate(null)
  vi.advanceTimersByTime(3000)
  if (!alreadyFake) vi.useRealTimers()
}

beforeAll(async () => {
  await settleWindowBehaviorConfig({ initWindowBehaviorConfig, armPetSizeGate })
})

function updateCachedWindowBehaviorConfig(
  config: { chatPinMode: 'always' | 'smart' | 'off'; petAvoidanceEnabled: boolean; petClickThrough?: boolean; petCollapsed?: boolean; appRules: Array<{ exeName: string; effect: 'allow' | 'soft' | 'hard' }> },
  mainWindow: Electron.BrowserWindow | null,
  overlayWindow: Electron.BrowserWindow | null
): void {
  testRevision += 1
  applyWindowBehaviorSnapshot({ generation: 'default-test-generation', revision: testRevision, config: { petClickThrough: false, petCollapsed: false, ...config } }, mainWindow, overlayWindow)
}

// 与 windowBehavior.ts 中的时长一致，用于推进假定时器
const PERSIST_DEBOUNCE_MS = 300
const PROGRAMMATIC_ECHO_TAIL_MS = 150

function makeDisplay(id: number, x: number) {
  return {
    id,
    bounds: { x, y: 0, width: 1920, height: 1080 },
    workArea: { x, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1,
  }
}

function makeFakeOverlayWindow(bounds: { x: number; y: number; width: number; height: number }) {
  return {
    isDestroyed: () => false,
    isVisible: () => false,
    isFocused: () => false,
    getOpacity: () => 1,
    showInactive: vi.fn(),
    hide: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    getBounds: () => bounds,
    webContents: { send: vi.fn() },
  }
}

function makeFakeChatWindow(bounds: { x: number; y: number; width: number; height: number }) {
  return {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    isFocused: () => false,
    showInactive: vi.fn(),
    hide: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    getBounds: () => bounds,
  }
}

// 每个用例使用相隔 100s 的假时钟；否则上一个用例留下的程序化移动冷却期会让下一个用例的 moved 被误判为回声
let nextFakeNowMs = 1_700_000_000_000

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  nextFakeNowMs += 100_000
  vi.setSystemTime(nextFakeNowMs)
  testState.displays = []
  testState.homeDisplayId = 1
  testState.matchDisplay = () => ({ id: 1 })
  testState.blockerMap = new Map()
  testState.dragging = { overlay: false, chat: false }
})

afterEach(() => {
  vi.useRealTimers()
})

// 渲染进程上报 ready 时重发上一次的呈现广播
describe('sendCurrentPetPresenceOnReady (Stage 3 part 2, FIX 2/FIX 3)', () => {
  it('(b) sends nothing when ready arrives before any evaluate has ever broadcast', async () => {
    // 用全新模块实例断言“从未广播过”；依赖 describe 声明顺序的话，别处插入用例会让本用例悄悄失效
    vi.resetModules()
    const fresh = await import('./windowBehavior')
    await settleWindowBehaviorConfig(fresh)
    fresh.closeStartupGate()

    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })

    fresh.sendCurrentPetPresenceOnReady(win as unknown as Electron.BrowserWindow)

    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('(a) re-sends the cached payload on ready after a prior broadcast', () => {
    testState.displays = [makeDisplay(1, 0)]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => ({ id: 1 })
    testState.blockerMap = new Map()
    testState.dragging = { overlay: false, chat: false }

    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow) // broadcasts AMBIENT once
    vi.clearAllMocks()

    sendCurrentPetPresenceOnReady(win as unknown as Electron.BrowserWindow)

    expect(win.webContents.send).toHaveBeenCalledWith('desktop-presence:changed', { presence: 'AMBIENT', edgeSide: null, handleSuppressed: false, collapsed: false, clickThrough: false })
  })

  it('(c) clears the stale hover flag and collapses a window a reloaded renderer would otherwise find stuck expanded', () => {
    const display1 = makeDisplay(1, 0)
    testState.displays = [display1]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => display1
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['user-rule']), severity: 'soft' }],
    ])
    testState.dragging = { overlay: false, chat: false }

    // -92 = 贴边收起后的 x（0 - (132 - 40)）
    const win = makeFakeOverlayWindow({ x: -92, y: 0, width: 132, height: 132 })
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow) // enters EDGE, still collapsed
    vi.clearAllMocks()

    requestOverlayEdgeHover(win as unknown as Electron.BrowserWindow, true) // hover expands it
    win.getBounds = () => ({ x: 0, y: 0, width: 132, height: 132 }) // model the (mocked) move having happened
    vi.clearAllMocks()

    // 渲染进程重载后没有 hover 信号；ready 必须清掉旧的 hover 并重新求值，否则窗口永远停在展开状态
    sendCurrentPetPresenceOnReady(win as unknown as Electron.BrowserWindow)

    expect(animateTo).toHaveBeenCalledWith(win, { x: -92, y: 0, width: 132, height: 132 }, expect.any(Function), { finalOpacity: 1 })
  })
})

describe('handleWindowMoved (Fix A — explicit in-flight/quiet-until state, not a re-stamped timestamp)', () => {
  // 程序化放置引发的 moved 回声不得落盘，否则会被当成用户拖拽写入偏好位置
  it('does not persist a programmatic-placement echo', () => {
    testState.displays = [makeDisplay(1, 0)]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => ({ id: 1 })

    markProgrammaticWindowPlacement('overlay')
    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })

    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, null)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

    expect(commitHomeDisplayFromDragOutcome).not.toHaveBeenCalled()
  })

  it('persists a genuine move (no programmatic placement/relocate in flight or in its quiet tail)', () => {
    testState.displays = [makeDisplay(1, 0)]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => ({ id: 1 })

    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })

    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, null)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

    expect(commitHomeDisplayFromDragOutcome).toHaveBeenCalledTimes(1)
  })
})

// 真实拖拽落在拓扑稳定静默期内时必须照常落盘；否则 drop 被当成回声丢弃，appliedDisplayId 不再更新
describe('persistBoundsNow Fix 9 — a real drag landing inside a topology-settle quiet window must still persist (mandatory sanity check iv)', () => {
  it('does not drop a drop that arrives 300ms into a 1000ms topology-settle quiet window, because the window itself is still being dragged', () => {
    testState.displays = [makeDisplay(1, 0)]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => ({ id: 1 })

    markTopologySettle() // 开启 1000ms 静默期

    testState.dragging = { overlay: true, chat: false }

    const win = makeFakeOverlayWindow({ x: 500, y: 0, width: 132, height: 132 })
    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, null)

    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10) // 防抖 300ms 到期时仍在静默期内

    expect(commitHomeDisplayFromDragOutcome).toHaveBeenCalledTimes(1)
  })
})

// 用 mockImplementationOnce 捕获 onComplete 而不调用，模拟尚未完成的动画
describe('Fix 1 (third rework pass) — preempting an in-flight animation must not release the replacement\'s bracket', () => {
  it('does not persist a moved event while a second, preempting relocate for the same window is still in flight', () => {
    const display1 = makeDisplay(1, 0)
    const display2 = makeDisplay(2, 1920)
    const display3 = makeDisplay(3, 3840)
    testState.displays = [display1, display2, display3]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => display1
    testState.blockerMap = new Map()
    testState.dragging = { overlay: false, chat: false }

    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })
    // 先收敛到 home，使模块状态不受前面用例影响
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    vi.clearAllMocks()

    // 第一次迁移到显示器 2，故意不完成
    let firstOnComplete: (() => void) | undefined
    vi.mocked(animateTo).mockImplementationOnce((_win, _target, onComplete) => {
      firstOnComplete = onComplete
      return () => {}
    })
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    expect(firstOnComplete).toBeDefined()

    // 第二次迁移到显示器 3，抢占第一次；真实 animateTo 会同步触发被抢占那次的 onComplete，被抢占者不得释放新一次的移动标记
    let secondOnComplete: (() => void) | undefined
    vi.mocked(animateTo).mockImplementationOnce((_win, _target, onComplete) => {
      secondOnComplete = onComplete
      firstOnComplete?.()
      return () => {}
    })
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
      [2, { hwnd: 2n, pid: 2, exeName: null, displayId: 2, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    // 让误启动的静默尾巴先过期：回声识别必须依赖仍在进行的移动标记，而不是定时器
    vi.advanceTimersByTime(PROGRAMMATIC_ECHO_TAIL_MS + 50)

    // 窗口位置已在显示器 3；若 moved 被误当作真实 drop 就会落盘，用例据此失败
    testState.matchDisplay = () => display3
    win.getBounds = () => ({ x: 3840, y: 0, width: 132, height: 132 })

    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, null)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

    expect(commitHomeDisplayFromDragOutcome).not.toHaveBeenCalled()

    // 收尾：关闭移动标记，避免 overlay 永远处于进行中而污染后续用例
    secondOnComplete?.()
  })
})

describe('Fix 2 (third rework pass) — a real drag landing inside the short post-cancel quiet tail must still persist', () => {
  it('does not drop a drop that arrives while still inside the post-cancellation quiet tail, because the window itself is being dragged', () => {
    const display1 = makeDisplay(1, 0)
    const display2 = makeDisplay(2, 1920)
    testState.displays = [display1]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => display1
    testState.blockerMap = new Map()
    testState.dragging = { overlay: false, chat: false }

    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })
    // 先收敛到 home
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    vi.clearAllMocks()

    // home 被挡，开始自动迁移到显示器 2；返回的 cancel 会触发 onComplete，与真实 animateTo 一致
    testState.displays = [display1, display2]
    let capturedOnComplete: (() => void) | undefined
    vi.mocked(animateTo).mockImplementationOnce((_win, _target, onComplete) => {
      capturedOnComplete = onComplete
      return () => {
        capturedOnComplete?.()
      }
    })
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    expect(animateTo).toHaveBeenCalledTimes(1)

    // 用户在动画途中抓住窗口，取消迁移，随即进入回声静默尾巴
    testState.dragging = { overlay: true, chat: false }
    cancelProgrammaticMoveOnDragStart('overlay')

    // 尾巴内到达的真实拖拽 moved 不得被当成回声丢弃，否则 drop 不会落盘
    testState.matchDisplay = () => display2
    win.getBounds = () => ({ x: 1920, y: 0, width: 132, height: 132 })

    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, null)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

    expect(commitHomeDisplayFromDragOutcome).toHaveBeenCalledTimes(1)
  })
})

describe('Fix C — a stale appliedDisplayId must not reach deriveDragContext after its display is unplugged', () => {
  it('treats the OS-forced repositioning after a refuge-display unplug as an at-home placement, not a phantom cross-display drag from a display that no longer exists', () => {
    // home 被挡，overlay 自动迁移到唯一空闲的显示器 2
    const display1 = makeDisplay(1, 0)
    const display2 = makeDisplay(2, 1920)
    testState.displays = [display1, display2]
    testState.homeDisplayId = 1
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    testState.matchDisplay = () => display2

    const win = makeFakeOverlayWindow({ x: 1920, y: 0, width: 132, height: 132 })
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    // 越过迁移的回声尾巴，避免下面的 moved 被当成迁移回声
    vi.advanceTimersByTime(PROGRAMMATIC_ECHO_TAIL_MS + 10)

    // 显示器 2 被拔掉，系统把窗口挪到显示器 3；moved 先于拓扑失效到达，必须仅靠 appliedDisplayIdFor 识别
    const display3 = makeDisplay(3, 3840)
    testState.displays = [display1, display3]
    testState.blockerMap = new Map()
    testState.matchDisplay = () => display3
    win.getBounds = () => ({ x: 3840, y: 0, width: 132, height: 132 })

    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, null)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

    // 已断开的显示器 2 不得作为拖拽起点；按“在家拖到别的空闲屏”处理，home 改为 3
    expect(commitHomeDisplayFromDragOutcome).toHaveBeenCalledWith('overlay', {
      kind: 'accept',
      newPreferredDisplayId: 3,
      boundsWriteDisplayId: 3,
    })
  })
})

describe('Fix 1 (second rework pass) — per-window drag state, not one global flag', () => {
  // 先收敛到 home，避免依赖前面用例遗留的模块状态
  function primeOverlayAtHome(win: ReturnType<typeof makeFakeOverlayWindow>) {
    testState.blockerMap = new Map()
    testState.dragging = { overlay: false, chat: false }
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    vi.clearAllMocks()
  }

  it('a chat drag does NOT make the pet ACTIVE — it still relocates away from a blocked home', () => {
    const display1 = makeDisplay(1, 0)
    const display2 = makeDisplay(2, 1920)
    testState.displays = [display1, display2]
    testState.homeDisplayId = 1

    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })
    primeOverlayAtHome(win)

    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    testState.dragging = { overlay: false, chat: true }
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    // chat 拖拽若误让宠物进入 ACTIVE，宠物就不会迁移到空闲的显示器 2
    expect(animateTo).toHaveBeenCalledWith(win, expect.objectContaining({ x: 1920, y: 0 }), expect.any(Function), { finalOpacity: 1 })
  })

  it('an overlay drag DOES make the pet ACTIVE — it stays put instead of relocating away from a blocked home', () => {
    const display1 = makeDisplay(1, 0)
    const display2 = makeDisplay(2, 1920)
    testState.displays = [display1, display2]
    testState.homeDisplayId = 1

    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })
    primeOverlayAtHome(win)

    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    testState.dragging = { overlay: true, chat: false }
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    // 条件与上一用例相同，只是拖拽的是 overlay 自己，所以必须原地不动
    expect(animateTo).not.toHaveBeenCalled()
  })

  it("each window's move-skip guard responds to its own drag only — chat still relocates while only the overlay is dragging", () => {
    const display1 = makeDisplay(1, 0)
    const display2 = makeDisplay(2, 1920)
    testState.displays = [display1, display2]
    testState.homeDisplayId = 1
    // 先把 chat 收敛到 home，避免依赖前面用例遗留的模块状态
    testState.blockerMap = new Map()
    testState.dragging = { overlay: false, chat: false }

    const chatWin = makeFakeChatWindow({ x: 0, y: 0, width: 290, height: 520 })
    updateCachedWindowBehaviorConfig({ chatPinMode: 'smart', petAvoidanceEnabled: true, appRules: [] }, chatWin as unknown as Electron.BrowserWindow, null)
    vi.clearAllMocks()

    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    testState.dragging = { overlay: true, chat: false }

    evaluateDesktopPresence(chatWin as unknown as Electron.BrowserWindow, null)

    expect(animateTo).toHaveBeenCalledWith(chatWin, expect.objectContaining({ x: 1920, y: 0 }), expect.any(Function), { finalOpacity: 1 })
  })

  it("each window's move-skip guard responds to its own drag only — chat does NOT relocate while it itself is dragging", () => {
    const display1 = makeDisplay(1, 0)
    const display2 = makeDisplay(2, 1920)
    testState.displays = [display1, display2]
    testState.homeDisplayId = 1
    // 先把 chat 收敛到 home，避免依赖前面用例遗留的模块状态
    testState.blockerMap = new Map()
    testState.dragging = { overlay: false, chat: false }

    const chatWin = makeFakeChatWindow({ x: 0, y: 0, width: 290, height: 520 })
    updateCachedWindowBehaviorConfig({ chatPinMode: 'smart', petAvoidanceEnabled: true, appRules: [] }, chatWin as unknown as Electron.BrowserWindow, null)
    vi.clearAllMocks()

    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    testState.dragging = { overlay: false, chat: true }

    evaluateDesktopPresence(chatWin as unknown as Electron.BrowserWindow, null)

    expect(animateTo).not.toHaveBeenCalled()
  })
})

describe('prepareChatForShow — chat is placed while hidden so the first show needs no move', () => {
  function makeHiddenChatWindow(bounds: { x: number; y: number; width: number; height: number }) {
    let visible = false
    return {
      isDestroyed: () => false,
      isMinimized: () => false,
      isVisible: () => visible,
      isFocused: () => false,
      show: () => {
        visible = true
      },
      showInactive: vi.fn(),
      hide: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      setBounds: vi.fn(),
      getBounds: () => bounds,
    }
  }

  it('smart mode: places the hidden window, then the post-show evaluation does not move it', () => {
    const display1 = makeDisplay(1, 0)
    const display2 = makeDisplay(2, 1920)
    testState.displays = [display1, display2]
    testState.homeDisplayId = 2
    testState.blockerMap = new Map()
    const chatWin = makeHiddenChatWindow({ x: 0, y: 0, width: 290, height: 520 })
    updateCachedWindowBehaviorConfig({ chatPinMode: 'smart', petAvoidanceEnabled: true, appRules: [] }, null, null)
    vi.clearAllMocks()

    const shouldShow = prepareChatForShow(chatWin as unknown as Electron.BrowserWindow)
    expect(shouldShow).toBe(true)
    expect(chatWin.setBounds).toHaveBeenCalledWith({ x: 1920, y: 0, width: 290, height: 520 })
    expect(animateTo).not.toHaveBeenCalled()

    chatWin.show()
    evaluateDesktopPresence(chatWin as unknown as Electron.BrowserWindow, null)
    expect(animateTo).not.toHaveBeenCalled()
  })

  it('smart mode: does not touch bounds that already match the target', () => {
    testState.displays = [makeDisplay(1, 0)]
    testState.homeDisplayId = 1
    testState.blockerMap = new Map()
    const chatWin = makeHiddenChatWindow({ x: 0, y: 0, width: 290, height: 520 })
    updateCachedWindowBehaviorConfig({ chatPinMode: 'smart', petAvoidanceEnabled: true, appRules: [] }, null, null)
    vi.clearAllMocks()

    prepareChatForShow(chatWin as unknown as Electron.BrowserWindow)

    expect(chatWin.setBounds).not.toHaveBeenCalled()
  })

  it('smart mode with the only display hard-blocked: reports not to show and leaves the window unmoved', () => {
    testState.displays = [makeDisplay(1, 0)]
    testState.homeDisplayId = 1
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    const chatWin = makeHiddenChatWindow({ x: 500, y: 0, width: 290, height: 520 })
    updateCachedWindowBehaviorConfig({ chatPinMode: 'smart', petAvoidanceEnabled: true, appRules: [] }, null, null)
    vi.clearAllMocks()

    const shouldShow = prepareChatForShow(chatWin as unknown as Electron.BrowserWindow)

    expect(shouldShow).toBe(false)
    expect(chatWin.setBounds).not.toHaveBeenCalled()
    expect(chatWin.showInactive).not.toHaveBeenCalled()
    expect(animateTo).not.toHaveBeenCalled()
  })

  it('smart mode: a show request while the only display is hard-blocked is kept and shown once the blocker clears', () => {
    testState.displays = [makeDisplay(1, 0)]
    testState.homeDisplayId = 1
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    const chatWin = makeHiddenChatWindow({ x: 0, y: 0, width: 290, height: 520 })
    updateCachedWindowBehaviorConfig({ chatPinMode: 'smart', petAvoidanceEnabled: true, appRules: [] }, null, null)
    vi.clearAllMocks()

    expect(prepareChatForShow(chatWin as unknown as Electron.BrowserWindow)).toBe(false)
    evaluateDesktopPresence(chatWin as unknown as Electron.BrowserWindow, null)
    expect(chatWin.showInactive).not.toHaveBeenCalled()

    testState.blockerMap = new Map()
    evaluateDesktopPresence(chatWin as unknown as Electron.BrowserWindow, null)
    expect(chatWin.showInactive).toHaveBeenCalledTimes(1)
  })

  it('smart mode: a chat window that was never asked to show stays hidden when a blocker clears', () => {
    testState.displays = [makeDisplay(1, 0)]
    testState.homeDisplayId = 1
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    const chatWin = makeHiddenChatWindow({ x: 0, y: 0, width: 290, height: 520 })
    updateCachedWindowBehaviorConfig({ chatPinMode: 'smart', petAvoidanceEnabled: true, appRules: [] }, null, null)
    evaluateDesktopPresence(chatWin as unknown as Electron.BrowserWindow, null)
    vi.clearAllMocks()

    testState.blockerMap = new Map()
    evaluateDesktopPresence(chatWin as unknown as Electron.BrowserWindow, null)
    expect(chatWin.showInactive).not.toHaveBeenCalled()
  })

  it('always mode: pins topmost and shows without moving', () => {
    testState.displays = [makeDisplay(1, 0)]
    testState.blockerMap = new Map()
    const chatWin = makeHiddenChatWindow({ x: 0, y: 0, width: 290, height: 520 })
    updateCachedWindowBehaviorConfig({ chatPinMode: 'always', petAvoidanceEnabled: true, appRules: [] }, null, null)
    vi.clearAllMocks()

    expect(prepareChatForShow(chatWin as unknown as Electron.BrowserWindow)).toBe(true)
    expect(chatWin.setBounds).not.toHaveBeenCalled()
    expect(animateTo).not.toHaveBeenCalled()
  })
})

describe('Fix 6 (second rework pass) — ACTIVE must not move a window the user is holding, even when currentDisplayId falls back to home after an invalidated appliedDisplayId', () => {
  it('does not call animateTo while interacting, even though a move would otherwise be computed', () => {
    const display1 = makeDisplay(1, 0)
    const display2 = makeDisplay(2, 1920)
    testState.displays = [display1, display2]
    testState.homeDisplayId = 1
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    testState.dragging = { overlay: false, chat: false }

    const win = makeFakeOverlayWindow({ x: 1920, y: 0, width: 132, height: 132 })
    // 先迁移到唯一空闲的显示器 2
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    vi.clearAllMocks()

    // 承载窗口的显示器 2 在交互中被拔掉，目标回退到 home；窗口位置与目标不符，但交互中仍不得移动
    testState.displays = [display1]
    testState.dragging = { overlay: true, chat: false }

    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    expect(animateTo).not.toHaveBeenCalled()
  })
})

// 交互中 applied 也必须落定到真实状态；否则 applied 永远到不了 ACTIVE，拖拽打断 EDGE 动画后还会卡在 EDGE
describe('Fix 1 — applied must settle to the truth while interacting, not get stuck behind an isInteracting early return', () => {
  it('(a) settles appliedPetPresence to ACTIVE while the user is interacting, from a plain AMBIENT baseline', () => {
    testState.displays = [makeDisplay(1, 0)]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => ({ id: 1 })
    testState.blockerMap = new Map()
    testState.dragging = { overlay: false, chat: false }

    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow) // settles at AMBIENT
    vi.clearAllMocks()

    testState.dragging = { overlay: true, chat: false }
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    expect(win.webContents.send).toHaveBeenCalledWith('desktop-presence:changed', {
      presence: 'ACTIVE',
      edgeSide: null,
      handleSuppressed: false,
      collapsed: false,
      clickThrough: false,
    })
  })

  it('(b) an EDGE-entry animation interrupted by a real drag settles applied all the way to ACTIVE in the same synchronous chain, instead of leaving it stuck at EDGE (and handleSuppressed fail-closed) for the rest of the drag', () => {
    const display1 = makeDisplay(1, 0)
    testState.displays = [display1]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => display1
    testState.blockerMap = new Map()
    testState.dragging = { overlay: false, chat: false }

    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow) // settle AMBIENT, appliedPetDisplayId = 1
    vi.clearAllMocks()

    // home 软阻挡且无处可去 -> EDGE；捕获入场动画的 onComplete，以便中途打断
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['user-rule']), severity: 'soft' }],
    ])
    let capturedOnComplete: (() => void) | undefined
    vi.mocked(animateTo).mockImplementationOnce((_win, _target, onComplete) => {
      capturedOnComplete = onComplete
      return () => {
        capturedOnComplete?.()
      }
    })

    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow) // begins collapsing into EDGE
    expect(animateTo).toHaveBeenCalledTimes(1)
    vi.clearAllMocks()

    // 用户中途抓住窗口：取消动画会先落定 EDGE，再带着交互状态重新求值
    testState.dragging = { overlay: true, chat: false }
    cancelProgrammaticMoveOnDragStart('overlay')

    // 同一同步链内必须落定到 ACTIVE，最后一次广播不能停在 EDGE
    expect(win.webContents.send).toHaveBeenLastCalledWith('desktop-presence:changed', {
      presence: 'ACTIVE',
      edgeSide: null,
      handleSuppressed: false,
      collapsed: false,
      clickThrough: false,
    })
  })
})

describe('Presence broadcast (Stage 3 part 2, Task 1) — desktop-presence:changed only on change', () => {
  // 每个用例先落定到已知呈现并清空 mock，再只断言增量，避免依赖前面用例遗留的广播状态
  it('does not broadcast again across repeated evaluates while the desired presence is unchanged', () => {
    testState.displays = [makeDisplay(1, 0)]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => ({ id: 1 })
    testState.blockerMap = new Map()
    testState.dragging = { overlay: false, chat: false }

    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    vi.clearAllMocks()

    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  // 进入 EDGE 广播两次：desired 一变就先发 handleSuppressed，presence/edgeSide 等收边动画落定后再发；之后不得重复发送
  it('broadcasts handleSuppressed the instant desired becomes EDGE, then presence/edgeSide once applied catches up, then falls silent while it stays EDGE', () => {
    const display1 = makeDisplay(1, 0)
    testState.displays = [display1]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => display1
    testState.blockerMap = new Map()
    testState.dragging = { overlay: false, chat: false }

    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow) // settle at AMBIENT
    vi.clearAllMocks()

    // 唯一的显示器被软阻挡，无处迁移 -> EDGE
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['user-rule']), severity: 'soft' }],
    ])

    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    expect(win.webContents.send).toHaveBeenCalledTimes(2)
    // 第一次：handleSuppressed 已为 true，presence/edgeSide 仍是转变前的 applied 状态
    expect(win.webContents.send).toHaveBeenNthCalledWith(1, 'desktop-presence:changed', {
      presence: 'AMBIENT',
      edgeSide: null,
      handleSuppressed: true,
      collapsed: false,
      clickThrough: false,
    })
    // 第二次：收边动画落定，presence/edgeSide 跟上
    expect(win.webContents.send).toHaveBeenNthCalledWith(2, 'desktop-presence:changed', {
      presence: 'EDGE',
      edgeSide: 'left',
      handleSuppressed: true,
      collapsed: false,
      clickThrough: false,
    })

    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    expect(win.webContents.send).toHaveBeenCalledTimes(2)
  })
})

describe('requestOverlayEdgeHover (Stage 3 part 2, Task 2)', () => {
  it('ignores a hover request when the pet is not EDGE — the guard lives in main, not in an assumption about the renderer', () => {
    testState.displays = [makeDisplay(1, 0)]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => ({ id: 1 })
    testState.blockerMap = new Map()
    testState.dragging = { overlay: false, chat: false }

    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow) // settles at AMBIENT, not EDGE
    vi.clearAllMocks()

    requestOverlayEdgeHover(win as unknown as Electron.BrowserWindow, true)

    expect(animateTo).not.toHaveBeenCalled()
  })

  it('expands to the full (preferred) bounds on hover while EDGE, and collapses back to the edge bounds on un-hover', () => {
    const display1 = makeDisplay(1, 0)
    testState.displays = [display1]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => display1
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['user-rule']), severity: 'soft' }],
    ])
    testState.dragging = { overlay: false, chat: false }

    // -92 = 贴边收起后的 x（0 - (132 - 40)）
    const win = makeFakeOverlayWindow({ x: -92, y: 0, width: 132, height: 132 })
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow) // enters EDGE
    vi.clearAllMocks()

    requestOverlayEdgeHover(win as unknown as Electron.BrowserWindow, true)
    expect(animateTo).toHaveBeenCalledTimes(1)
    expect(animateTo).toHaveBeenCalledWith(win, { x: 0, y: 0, width: 132, height: 132 }, expect.any(Function), { finalOpacity: 1 })

    win.getBounds = () => ({ x: 0, y: 0, width: 132, height: 132 })
    vi.clearAllMocks()

    requestOverlayEdgeHover(win as unknown as Electron.BrowserWindow, false)
    expect(animateTo).toHaveBeenCalledTimes(1)
    expect(animateTo).toHaveBeenCalledWith(win, { x: -92, y: 0, width: 132, height: 132 }, expect.any(Function), { finalOpacity: 1 })
  })

  it('a hover expand does not change presence, does not clear rememberedPetEdgeSide, and does not end the EDGE episode — a subsequent unrelated evaluate stays EDGE with the same side', () => {
    const display1 = makeDisplay(1, 0)
    testState.displays = [display1]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => display1
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['user-rule']), severity: 'soft' }],
    ])
    testState.dragging = { overlay: false, chat: false }

    const win = makeFakeOverlayWindow({ x: -92, y: 0, width: 132, height: 132 })
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow) // enters EDGE, side = left
    vi.clearAllMocks()

    requestOverlayEdgeHover(win as unknown as Electron.BrowserWindow, true)
    win.getBounds = () => ({ x: 0, y: 0, width: 132, height: 132 })
    vi.clearAllMocks()

    // 展开状态下无关的重新求值（如 blocker 复查）既不广播也不再移动窗口
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    expect(win.webContents.send).not.toHaveBeenCalled()
    expect(animateTo).not.toHaveBeenCalled()
  })
})

describe('EDGE episode exit restores the window (bug fix: applyEdgePlacement used to only clear its own remembered side/hover state on exit, never move the window back — it stayed parked at the edge x forever)', () => {
  it('restores to the full (preferred) bounds when the episode ends while still collapsed at the edge', () => {
    const display1 = makeDisplay(1, 0)
    testState.displays = [display1]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => display1
    testState.dragging = { overlay: false, chat: false }

    // 先收敛到 home/AMBIENT，避免依赖前面用例遗留的模块状态
    const win = makeFakeOverlayWindow({ x: -92, y: 0, width: 132, height: 132 })
    testState.blockerMap = new Map()
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    vi.clearAllMocks()

    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['user-rule']), severity: 'soft' }],
    ])
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow) // enters EDGE, still collapsed
    vi.clearAllMocks()

    // 阻挡解除后显示器不变，只有 EDGE 退出逻辑能把窗口移回；否则窗口永远停在边缘
    testState.blockerMap = new Map()
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    expect(animateTo).toHaveBeenCalledTimes(1)
    expect(animateTo).toHaveBeenCalledWith(win, { x: 0, y: 0, width: 132, height: 132 }, expect.any(Function), { finalOpacity: 1 })
  })

  it('restores to the same full bounds when the episode ends while hovered/expanded — no redundant re-animation, since the hover expansion and the exit restore share the same fullBounds computation', () => {
    const display1 = makeDisplay(1, 0)
    testState.displays = [display1]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => display1
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['user-rule']), severity: 'soft' }],
    ])
    testState.dragging = { overlay: false, chat: false }

    const win = makeFakeOverlayWindow({ x: -92, y: 0, width: 132, height: 132 })
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow) // enters EDGE, side = left
    vi.clearAllMocks()

    requestOverlayEdgeHover(win as unknown as Electron.BrowserWindow, true) // expand
    expect(animateTo).toHaveBeenCalledWith(win, { x: 0, y: 0, width: 132, height: 132 }, expect.any(Function), { finalOpacity: 1 })
    win.getBounds = () => ({ x: 0, y: 0, width: 132, height: 132 })
    vi.clearAllMocks()

    testState.blockerMap = new Map() // episode ends while still hovered/expanded
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    // 已在还原位置，不得再播一次多余的动画
    expect(animateTo).not.toHaveBeenCalled()
  })

  it('issues no further moves on repeated evaluates once the episode has ended and the window has been restored', () => {
    const display1 = makeDisplay(1, 0)
    testState.displays = [display1]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => display1
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['user-rule']), severity: 'soft' }],
    ])
    testState.dragging = { overlay: false, chat: false }

    const win = makeFakeOverlayWindow({ x: -92, y: 0, width: 132, height: 132 })
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow) // enters EDGE
    vi.clearAllMocks()

    testState.blockerMap = new Map()
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow) // episode ends, restores
    expect(animateTo).toHaveBeenCalledTimes(1)
    win.getBounds = () => ({ x: 0, y: 0, width: 132, height: 132 })
    vi.clearAllMocks()

    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    expect(animateTo).not.toHaveBeenCalled()
  })

  it('marks the restore as programmatic — a "moved" event that arrives right after it must not be persisted as a user drag', () => {
    const display1 = makeDisplay(1, 0)
    testState.displays = [display1]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => display1
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['user-rule']), severity: 'soft' }],
    ])
    testState.dragging = { overlay: false, chat: false }

    const win = makeFakeOverlayWindow({ x: -92, y: 0, width: 132, height: 132 })
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow) // enters EDGE
    vi.clearAllMocks()

    testState.blockerMap = new Map()
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow) // episode ends, restores
    expect(animateTo).toHaveBeenCalledTimes(1)

    // 还原必须按程序化移动记账；否则其回声会被当成用户拖拽写入偏好位置
    win.getBounds = () => ({ x: 0, y: 0, width: 132, height: 132 })
    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, null)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

    expect(commitHomeDisplayFromDragOutcome).not.toHaveBeenCalled()
  })
})

// 仍在进行的 relocate 不得让 resolver 跳过求值；否则 handleSuppressed 安全门要等 relocate 落定才广播
describe('Resolver keeps thinking while a move is in flight — handleSuppressed fires immediately, independent of bounds settling (mandatory sanity checks i/ii)', () => {
  it('broadcasts handleSuppressed the instant a new EDGE intent is resolved, even though the relocate that must happen first is still in flight', () => {
    const display1 = makeDisplay(1, 0) // home
    const display2 = makeDisplay(2, 1920) // refuge
    testState.displays = [display1, display2]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => display1
    testState.dragging = { overlay: false, chat: false }

    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })
    testState.blockerMap = new Map()
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow) // settle at home, AMBIENT
    vi.clearAllMocks()

    // home 被硬阻挡，迁移到显示器 2；故意不完成，作为仍在进行的移动
    let capturedRelocateOnComplete: (() => void) | undefined
    vi.mocked(animateTo).mockImplementationOnce((_win, _target, onComplete) => {
      capturedRelocateOnComplete = onComplete
      return () => {}
    })
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    expect(capturedRelocateOnComplete).toBeDefined()

    // 下面第二次迁移（回 home）同样捕获但不完成
    let capturedSecondRelocateOnComplete: (() => void) | undefined
    vi.mocked(animateTo).mockImplementationOnce((_win, _target, onComplete) => {
      capturedSecondRelocateOnComplete = onComplete
      return () => {}
    })
    vi.clearAllMocks()

    // 迁移未完成时显示器 2 也被硬阻挡、home 变软阻挡 -> desired 变为 EDGE；handleSuppressed 必须在这次求值里就变为 true
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['user-rule']), severity: 'soft' }],
      [2, { hwnd: 2n, pid: 2, exeName: null, displayId: 2, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    expect(win.webContents.send).toHaveBeenCalledWith(
      'desktop-presence:changed',
      expect.objectContaining({ handleSuppressed: true })
    )

    // 此时 applied 仍是 AMBIENT，所以只能来自 desired；收尾时释放移动标记，避免污染后续用例
    capturedRelocateOnComplete?.()
    capturedSecondRelocateOnComplete?.()
  })
})

// 同一次评估里既要跨屏迁移又要贴边时，贴边位置必须等迁移落定后，按目标屏的实际几何计算
describe('geometry rule — EDGE bounds computation is deferred past an in-flight relocate instead of reading stale getBounds()', () => {
  it('does not compute EDGE bounds until the relocate that lands the window back home has actually completed', () => {
    const display1 = makeDisplay(1, 0) // home: y=0
    const display2 = { id: 2, bounds: { x: 1920, y: 300, width: 1920, height: 800 }, workArea: { x: 1920, y: 300, width: 1920, height: 800 }, scaleFactor: 1 } // deliberately different vertical geometry
    testState.displays = [display1, display2]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => display1
    testState.dragging = { overlay: false, chat: false }

    // 第一步：home 硬阻挡，避难到显示器 2
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    win.getBounds = () => ({ x: 1920, y: 300, width: 132, height: 132 }) // model the relocate having landed on display 2
    vi.clearAllMocks()

    // 第二步：home 变软阻挡、显示器 2 也被阻挡 -> 需先迁回 home 再贴边
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['user-rule']), severity: 'soft' }],
      [2, { hwnd: 2n, pid: 2, exeName: null, displayId: 2, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    let capturedRelocateOnComplete: (() => void) | undefined
    vi.mocked(animateTo).mockImplementationOnce((_win, _target, onComplete) => {
      capturedRelocateOnComplete = onComplete
      return () => {}
    })

    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    // 此刻只有迁移自己的动画，不得按显示器 2 的旧几何同步算出 EDGE 目标
    expect(animateTo).toHaveBeenCalledTimes(1)
    expect(capturedRelocateOnComplete).toBeDefined()

    // 迁移途中再触发一次求值（如轮询）：不得因本次没发起移动就读旧几何，算出错误的 EDGE 目标
    vi.clearAllMocks()
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    expect(animateTo).not.toHaveBeenCalled()
    expect(win.webContents.send).not.toHaveBeenCalled()

    win.getBounds = () => ({ x: 0, y: 0, width: 132, height: 132 })
    capturedRelocateOnComplete?.()

    // 落定后才按显示器 1 的几何（y=0，而非显示器 2 的 y=300）算 EDGE；-92 = 0 - (132 - 40)
    expect(animateTo).toHaveBeenCalledTimes(1)
    expect(animateTo).toHaveBeenLastCalledWith(win, { x: -92, y: 0, width: 132, height: 132 }, expect.any(Function), { finalOpacity: 1 })
  })
})

// EDGE 退出的广播必须等还原动画落定；否则渲染进程会在窗口仍在补间时就解除拖拽手柄的抑制
describe('broadcast follows applied — the EDGE-exit presence broadcast is deferred until the restore animation actually completes', () => {
  it('does not broadcast the post-EDGE presence until the exit-restore animation finishes', () => {
    const display1 = makeDisplay(1, 0)
    testState.displays = [display1]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => display1
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['user-rule']), severity: 'soft' }],
    ])
    testState.dragging = { overlay: false, chat: false }

    const win = makeFakeOverlayWindow({ x: -92, y: 0, width: 132, height: 132 })
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow) // enters EDGE, still collapsed
    vi.clearAllMocks()

    // 阻挡解除，还原动画尚未完成
    testState.blockerMap = new Map()
    let capturedRestoreOnComplete: (() => void) | undefined
    vi.mocked(animateTo).mockImplementationOnce((_win, _target, onComplete) => {
      capturedRestoreOnComplete = onComplete
      return () => {}
    })

    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    // 动画已排队但未完成，广播不得发出
    expect(animateTo).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).not.toHaveBeenCalled()

    // 还原途中再求值一次：既不得提前广播，也不得再排队第二次还原
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    expect(animateTo).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).not.toHaveBeenCalled()

    win.getBounds = () => ({ x: 0, y: 0, width: 132, height: 132 })
    capturedRestoreOnComplete?.()

    expect(win.webContents.send).toHaveBeenCalledWith('desktop-presence:changed', { presence: 'AMBIENT', edgeSide: null, handleSuppressed: false, collapsed: false, clickThrough: false })
  })
})

// EDGE 退出并伴随跨屏迁移时，广播同样必须等迁移落定
describe('broadcast follows applied, relocate path — the EDGE-exit-via-relocate presence broadcast is deferred until the relocate settles', () => {
  it('does not broadcast AMBIENT until the cross-display relocate animation actually completes', () => {
    const display1 = makeDisplay(1, 0)
    const display2 = makeDisplay(2, 1920)
    testState.displays = [display1, display2]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => display1
    testState.dragging = { overlay: false, chat: false }

    // 第一步：home 软阻挡、显示器 2 也被阻挡 -> home 贴边
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['user-rule']), severity: 'soft' }],
      [2, { hwnd: 2n, pid: 2, exeName: null, displayId: 2, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    const win = makeFakeOverlayWindow({ x: -92, y: 0, width: 132, height: 132 })
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow) // enters EDGE at home
    vi.clearAllMocks()

    // 第二步：显示器 2 空闲 -> 迁移过去，呈现回到 AMBIENT
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['user-rule']), severity: 'soft' }],
    ])
    let capturedRelocateOnComplete: (() => void) | undefined
    vi.mocked(animateTo).mockImplementationOnce((_win, _target, onComplete) => {
      capturedRelocateOnComplete = onComplete
      return () => {}
    })

    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    // 迁移刚开始，广播不得发出
    expect(animateTo).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).not.toHaveBeenCalled()

    // 迁移途中再求值：不得再排队迁移，也不得提前广播
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    expect(animateTo).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).not.toHaveBeenCalled()

    win.getBounds = () => ({ x: 1920, y: 0, width: 132, height: 132 })
    capturedRelocateOnComplete?.()

    expect(win.webContents.send).toHaveBeenCalledWith('desktop-presence:changed', { presence: 'AMBIENT', edgeSide: null, handleSuppressed: false, collapsed: false, clickThrough: false })
  })
})

// 目标依次变为 B、C、A、C 时只结算最后的 C，中间目标全部丢弃；不得排队依次执行
describe('no move queue — chasing a rapidly-changing desired target settles only on the final one, discarding intermediate targets (mandatory sanity check iii)', () => {
  it('settles on C (the final target) after B, C, A, C are each decided in turn while the previous relocate is still in flight, without ever completing B or A', () => {
    const displayHome = makeDisplay(1, 0)
    const displayB = makeDisplay(2, 1920)
    const displayC = makeDisplay(3, 3840)
    testState.displays = [displayHome, displayB, displayC]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => displayHome
    testState.dragging = { overlay: false, chat: false }

    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })
    testState.blockerMap = new Map()
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow) // settle at home, AMBIENT
    vi.clearAllMocks()

    const captured: Array<() => void> = []
    function captureNextAnimateTo() {
      vi.mocked(animateTo).mockImplementationOnce((_win, _target, onComplete) => {
        captured.push(onComplete!)
        return () => {}
      })
    }

    // 目标 B：home 被挡，B 空闲
    captureNextAnimateTo()
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    expect(animateTo).toHaveBeenLastCalledWith(win, expect.objectContaining({ x: displayB.bounds.x }), expect.any(Function), { finalOpacity: 1 })

    // 目标 C：B 也被挡
    captureNextAnimateTo()
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
      [2, { hwnd: 2n, pid: 2, exeName: null, displayId: 2, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    expect(animateTo).toHaveBeenLastCalledWith(win, expect.objectContaining({ x: displayC.bounds.x }), expect.any(Function), { finalOpacity: 1 })

    // 目标 A（home）：home 空闲、C 被挡
    captureNextAnimateTo()
    testState.blockerMap = new Map([
      [2, { hwnd: 2n, pid: 2, exeName: null, displayId: 2, reasons: new Set(['fullscreen']), severity: 'hard' }],
      [3, { hwnd: 3n, pid: 3, exeName: null, displayId: 3, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    expect(animateTo).toHaveBeenLastCalledWith(win, expect.objectContaining({ x: displayHome.bounds.x }), expect.any(Function), { finalOpacity: 1 })

    // 目标 C（最终）：home 重新被挡，B 仍被挡，C 空闲
    captureNextAnimateTo()
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
      [2, { hwnd: 2n, pid: 2, exeName: null, displayId: 2, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    expect(animateTo).toHaveBeenLastCalledWith(win, expect.objectContaining({ x: displayC.bounds.x }), expect.any(Function), { finalOpacity: 1 })

    expect(captured).toHaveLength(4)
    vi.clearAllMocks()

    // 三个已被取代的目标落定必须是空操作
    captured[0]() // B
    captured[1]() // C（第一次）
    captured[2]() // A
    expect(animateTo).not.toHaveBeenCalled()

    // 最终目标落定后窗口在 C 上，再求值无事可做
    captured[3]()
    win.getBounds = () => ({ x: displayC.bounds.x, y: 0, width: 132, height: 132 })
    vi.clearAllMocks()
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    expect(animateTo).not.toHaveBeenCalled()
  })

  // 上一用例测不到落定时对 presence 的再确认；这里用 EDGE -> HIDDEN 验证
  it('reconciles to the true final presence (HIDDEN) after an EDGE-entry animation settles, even though desired changed away from EDGE while that animation was still in flight', () => {
    const display1 = makeDisplay(1, 0)
    testState.displays = [display1]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => display1
    testState.dragging = { overlay: false, chat: false }

    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })
    testState.blockerMap = new Map()
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow) // settle at home, AMBIENT
    vi.clearAllMocks()

    // 单屏软阻挡 -> EDGE；入场动画捕获但不完成
    let capturedEntryOnComplete: (() => void) | undefined
    vi.mocked(animateTo).mockImplementationOnce((win: { getBounds: () => unknown }, target, onComplete) => {
      win.getBounds = () => target
      capturedEntryOnComplete = onComplete
      return () => {}
    })
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['user-rule']), severity: 'soft' }],
    ])
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    expect(capturedEntryOnComplete).toBeDefined()

    // 入场动画未完成时 home 升级为硬阻挡，desired 变为 HIDDEN
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    vi.clearAllMocks()

    // 落定后不能停在 EDGE，必须再确认最新 desired 并转为 HIDDEN；否则最后一次广播永远是 EDGE
    capturedEntryOnComplete?.()

    expect(win.webContents.send).toHaveBeenLastCalledWith(
      'desktop-presence:changed',
      expect.objectContaining({ presence: 'HIDDEN' })
    )
  })
})

// 嵌套的新一代移动先登记了自己的 cancel 时，外层已被取代的 cancel 不得覆盖它
describe('moveToDisplay FIX 3 — does not let a stale, already-superseded cancel function clobber a newer in-flight one', () => {
  it('retains the nested (current-generation) cancel function, not the outer (superseded) one', () => {
    const display1 = makeDisplay(1, 0)
    const display2 = makeDisplay(2, 1920)
    const display3 = makeDisplay(3, 3840)
    testState.displays = [display1, display2, display3]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => display1
    testState.dragging = { overlay: false, chat: false }
    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })

    // 先收敛到 home，避免依赖前面用例遗留的模块状态
    testState.blockerMap = new Map()
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    vi.clearAllMocks()

    // home 与显示器 3 被硬阻挡 -> 迁移到显示器 2
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
      [3, { hwnd: 3n, pid: 3, exeName: null, displayId: 3, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])

    const cancelOuter = vi.fn()
    const cancelNested = vi.fn()

    vi.mocked(animateTo)
      .mockImplementationOnce((_win, _target, onComplete) => {
        // 外层动画完成前显示器 2 被挡、3 空闲；同步 onComplete 触发嵌套求值，再迁移到 3 并先登记自己的 cancel
        testState.blockerMap = new Map([
          [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
          [2, { hwnd: 2n, pid: 2, exeName: null, displayId: 2, reasons: new Set(['fullscreen']), severity: 'hard' }],
        ])
        onComplete?.()
        return cancelOuter
      })
      .mockImplementationOnce((_win, _target, onComplete) => {
        onComplete?.()
        return cancelNested
      })

    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    expect(animateTo).toHaveBeenCalledTimes(2)

    // 拖拽开始时调用的必须是嵌套（当前一代）的 cancel
    cancelProgrammaticMoveOnDragStart('overlay')
    expect(cancelNested).toHaveBeenCalledTimes(1)
    expect(cancelOuter).not.toHaveBeenCalled()
  })
})

// 落点确定后必须立刻重新求值；否则要等 1500ms 轮询才收敛
describe('drag-end 后主动收敛（不依赖 1500ms 轮询）', () => {
  function twoDisplays() {
    const display1 = makeDisplay(1, 0)
    const display2 = makeDisplay(2, 1920)
    testState.displays = [display1, display2]
    testState.homeDisplayId = 1
    return { display1, display2 }
  }

  it('合法 drop：位置提交完成后立刻重新求值，无需推进定时 validator', () => {
    const { display2 } = twoDisplays()
    testState.blockerMap = new Map()
    testState.matchDisplay = () => display2
    testState.dragging = { overlay: true, chat: false }

    const win = makeFakeOverlayWindow({ x: 1920, y: 0, width: 132, height: 132 })
    win.getBounds = () => ({ x: 1920, y: 0, width: 132, height: 132 })

    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, win as unknown as Electron.BrowserWindow)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

    // 拖拽尾巴已收掉，说明重新求值发生过
    expect(revalidateBlockersNowMock).toHaveBeenCalledTimes(1)
    expect(revalidateBlockersNowMock).toHaveBeenCalledWith({ forceConservative: true })
    expect(testState.dragging.overlay).toBe(false)
  })

  it('顺序固定：blocker 复查发生在拖拽尾巴被收掉之前', () => {
    const { display2 } = twoDisplays()
    testState.blockerMap = new Map()
    testState.matchDisplay = () => display2
    testState.dragging = { overlay: true, chat: false }

    // 复查时尾巴必须仍开着；否则 conservative 模式选不中
    let draggingWhenRevalidated: boolean | null = null
    revalidateBlockersNowMock.mockImplementation(() => {
      draggingWhenRevalidated = testState.dragging.overlay
    })

    const win = makeFakeOverlayWindow({ x: 1920, y: 0, width: 132, height: 132 })
    win.getBounds = () => ({ x: 1920, y: 0, width: 132, height: 132 })

    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, win as unknown as Electron.BrowserWindow)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

    expect(draggingWhenRevalidated).toBe(true)
    expect(testState.dragging.overlay).toBe(false)
  })

  it('非法 drop：回滚 settle 之后才收敛，且不写入被拒绝的位置', () => {
    const { display1, display2 } = twoDisplays()

    // home(1) 被挡，窗口自动避难到 2，同时建立回滚落点
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    testState.matchDisplay = () => display2
    const win = makeFakeOverlayWindow({ x: 1920, y: 0, width: 132, height: 132 })
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    vi.advanceTimersByTime(PROGRAMMATIC_ECHO_TAIL_MS + 10)
    vi.clearAllMocks()

    // 拖回仍被挡的 home(1) -> reject
    testState.dragging = { overlay: true, chat: false }
    testState.matchDisplay = () => display1
    win.getBounds = () => ({ x: 0, y: 0, width: 132, height: 132 })

    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, win as unknown as Electron.BrowserWindow)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

    expect(commitHomeDisplayFromDragOutcome).not.toHaveBeenCalled()
    expect(revalidateBlockersNowMock).toHaveBeenCalledTimes(1)
    expect(revalidateBlockersNowMock).toHaveBeenCalledWith({ forceConservative: true })
    expect(testState.dragging.overlay).toBe(false)
  })

  it('一次 drag-end 只触发一次主动收敛', () => {
    const { display2 } = twoDisplays()
    testState.blockerMap = new Map()
    testState.matchDisplay = () => display2
    testState.dragging = { overlay: true, chat: false }

    const win = makeFakeOverlayWindow({ x: 1920, y: 0, width: 132, height: 132 })
    win.getBounds = () => ({ x: 1920, y: 0, width: 132, height: 132 })

    // 逐帧到达的多个 moved 经防抖合并为一次
    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, win as unknown as Electron.BrowserWindow)
    vi.advanceTimersByTime(50)
    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, win as unknown as Electron.BrowserWindow)
    vi.advanceTimersByTime(50)
    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, win as unknown as Electron.BrowserWindow)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

    expect(revalidateBlockersNowMock).toHaveBeenCalledTimes(1)
    expect(revalidateBlockersNowMock).toHaveBeenCalledWith({ forceConservative: true })
  })
})

// 从 HIDDEN / EDGE / RELOCATED 三种 applied 出发，关闭避让后都必须收敛到 AMBIENT @ home；纯函数层区分不了这三种来源
describe('关闭 petAvoidanceEnabled 后退出托管状态（Controller 层）', () => {
  const AVOIDANCE_ON = { chatPinMode: 'off' as const, petAvoidanceEnabled: true, appRules: [] }
  const AVOIDANCE_OFF = { chatPinMode: 'off' as const, petAvoidanceEnabled: false, appRules: [] }
  const HOME_BOUNDS = { x: 0, y: 0, width: 132, height: 132 }

  // show/hide 会真的翻转可见性；共用的 fake 的 isVisible 恒为 false，测不出 HIDDEN → 可见
  function makeOverlay() {
    let visible = true
    return {
      isDestroyed: () => false,
      isVisible: () => visible,
      isFocused: () => false,
      showInactive: vi.fn(() => {
        visible = true
      }),
      hide: vi.fn(() => {
        visible = false
      }),
      setAlwaysOnTop: vi.fn(),
      getOpacity: () => 1,
      getBounds: () => HOME_BOUNDS,
      webContents: { send: vi.fn() },
    }
  }

  function lastPresencePayload(win: ReturnType<typeof makeOverlay>) {
    const frames = win.webContents.send.mock.calls.filter(call => call[0] === 'desktop-presence:changed')
    return frames.length > 0 ? frames[frames.length - 1][1] : null
  }

  function blocker(displayId: number, severity: 'soft' | 'hard') {
    return { hwnd: 1n, pid: 1, exeName: null, displayId, reasons: new Set(['fullscreen']), severity }
  }

  const ROWS = [
    {
      name: 'HIDDEN',
      displayCount: 1,
      homeSeverity: 'hard' as const,
      managedPresence: 'HIDDEN' as string | null,
      managedDisplayX: null as number | null,
      // HIDDEN 时置顶为 false，退出托管必须恢复为 true
      expectsAlwaysOnTopRestored: true,
      expectsHomeBounds: false,
    },
    {
      name: 'EDGE',
      displayCount: 1,
      homeSeverity: 'soft' as const,
      managedPresence: 'EDGE' as string | null,
      managedDisplayX: null as number | null,
      expectsAlwaysOnTopRestored: false,
      expectsHomeBounds: true,
    },
    {
      name: 'RELOCATED',
      displayCount: 2,
      homeSeverity: 'hard' as const,
      // 托管态仍是 AMBIENT，广播被幂等短路，没有帧可读，改断言落点在第二块屏
      managedPresence: null as string | null,
      managedDisplayX: 1920 as number | null,
      expectsAlwaysOnTopRestored: false,
      expectsHomeBounds: true,
    },
  ]

  for (const row of ROWS) {
    it(`applied ${row.name} → 关闭避让 → AMBIENT @ home`, () => {
      const displays = Array.from({ length: row.displayCount }, (_, i) => makeDisplay(i + 1, i * 1920))
      testState.displays = displays
      testState.homeDisplayId = 1
      testState.matchDisplay = () => displays[0]
      testState.blockerMap = new Map([[1, blocker(1, row.homeSeverity)]])

      const win = makeOverlay()

      updateCachedWindowBehaviorConfig(AVOIDANCE_ON, null, win as unknown as Electron.BrowserWindow)
      if (row.managedPresence !== null) {
        expect(lastPresencePayload(win)?.presence).toBe(row.managedPresence)
      }
      if (row.managedDisplayX !== null) {
        expect(win.getBounds().x).toBe(row.managedDisplayX)
      }

      vi.clearAllMocks()
      updateCachedWindowBehaviorConfig(AVOIDANCE_OFF, null, win as unknown as Electron.BrowserWindow)

      expect(win.isVisible()).toBe(true)
      if (row.expectsAlwaysOnTopRestored) {
        expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, expect.anything())
      }
      if (row.expectsHomeBounds) {
        // EDGE 与 RELOCATED 都必须回到 home 的完整 bounds
        expect(win.getBounds()).toEqual(HOME_BOUNDS)
      }

      win.webContents.send.mockClear()
      sendCurrentPetPresenceOnReady(win as unknown as Electron.BrowserWindow)
      expect(lastPresencePayload(win)).toEqual({ presence: 'AMBIENT', edgeSide: null, handleSuppressed: false, collapsed: false, clickThrough: false })

      // 再求值不得产生新的物理动作
      vi.clearAllMocks()
      evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
      expect(animateTo).not.toHaveBeenCalled()
      expect(win.showInactive).not.toHaveBeenCalled()
      expect(win.hide).not.toHaveBeenCalled()
    })
  }
})

// reject 之后窗口必须真的弹回去；否则非法位置会留在屏幕上
describe('非法 drop 的回滚接线', () => {
  function blocker(displayId: number) {
    return { hwnd: 1n, pid: 1, exeName: null, displayId, reasons: new Set(['fullscreen']), severity: 'hard' }
  }

  type Rect = { x: number; y: number; width: number; height: number }

  // 矩形是否落在仍连着的某块显示器的 workArea 内
  function intersectsConnectedWorkArea(rect: Rect, connected: ReturnType<typeof makeDisplay>[]) {
    return connected.some(display => {
      const area = display.workArea
      return (
        rect.x < area.x + area.width &&
        rect.x + rect.width > area.x &&
        rect.y < area.y + area.height &&
        rect.y + rect.height > area.y
      )
    })
  }

  // home(1) 被挡，自动避难到 2，并把回滚落点记为 2
  function relocateToDisplayTwo(displays: ReturnType<typeof makeDisplay>[]) {
    // 先收敛到 home，避免依赖前面用例遗留的模块状态
    openStartupGate()
    testState.displays = displays
    testState.homeDisplayId = 1
    testState.blockerMap = new Map()
    testState.matchDisplay = () => displays[0]

    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })
    // 显式打开避让；否则恒为 AMBIENT@home，不会避难
    updateCachedWindowBehaviorConfig(
      { chatPinMode: 'off', petAvoidanceEnabled: true, appRules: [] },
      null,
      win as unknown as Electron.BrowserWindow
    )
    vi.advanceTimersByTime(PROGRAMMATIC_ECHO_TAIL_MS + 10)

    testState.blockerMap = new Map([[1, blocker(1)]])
    testState.matchDisplay = () => displays[1]
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    vi.advanceTimersByTime(PROGRAMMATIC_ECHO_TAIL_MS + 10)
    expect(win.getBounds()).toEqual({ x: 1920, y: 0, width: 132, height: 132 })
    return win
  }

  it('场景一：拖到被挡的显示器 → 窗口实际回到 lastValidTemporaryPlacement，非法位置不写入偏好', () => {
    const displays = [makeDisplay(1, 0), makeDisplay(2, 1920), makeDisplay(3, 3840)]
    const win = relocateToDisplayTwo(displays)
    vi.clearAllMocks()

    // 拖到同样被挡的 3
    testState.blockerMap = new Map([[1, blocker(1)], [3, blocker(3)]])
    testState.dragging = { overlay: true, chat: false }
    testState.matchDisplay = () => displays[2]
    win.getBounds = () => ({ x: 3840, y: 0, width: 132, height: 132 })

    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, win as unknown as Electron.BrowserWindow)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

    // 弹回显示器 2 的落点
    expect(win.getBounds()).toEqual({ x: 1920, y: 0, width: 132, height: 132 })
    // 被拒绝的拖拽不写偏好
    expect(setPreferredBoundsMock).not.toHaveBeenCalledWith('overlay', 3, expect.anything())
    expect(commitHomeDisplayFromDragOutcome).not.toHaveBeenCalled()
  })

  it('回滚仍在进行时到达的新意图不会丢失，settle 之后被消费', () => {
    const displays = [makeDisplay(1, 0), makeDisplay(2, 1920), makeDisplay(3, 3840)]
    const win = relocateToDisplayTwo(displays)
    vi.clearAllMocks()

    // 让回滚停在半空：捕获 onComplete，不立即调用
    let finishRollback: (() => void) | undefined
    vi.mocked(animateTo).mockImplementationOnce((animatedWin, target, onComplete) => {
      finishRollback = () => {
        ;(animatedWin as unknown as { getBounds: () => unknown }).getBounds = () => target
        onComplete?.()
      }
      return () => {}
    })

    testState.blockerMap = new Map([[1, blocker(1)], [3, blocker(3)]])
    testState.dragging = { overlay: true, chat: false }
    testState.matchDisplay = () => displays[2]
    win.getBounds = () => ({ x: 3840, y: 0, width: 132, height: 132 })

    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, win as unknown as Electron.BrowserWindow)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)
    expect(finishRollback).toBeDefined()

    // 回滚未落定时 home 解除阻挡，最新意图变为回 home
    testState.blockerMap = new Map()
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    // 用户仍捏着窗口，这次求值不得移动它
    expect(win.getBounds()).toEqual({ x: 3840, y: 0, width: 132, height: 132 })

    // 回滚落定后消费最新意图，回到 home
    finishRollback!()

    expect(win.getBounds()).toEqual({ x: 0, y: 0, width: 132, height: 132 })
  })
  // 临时屏断开后按“在家拖拽”处理；否则会尝试回到已断开的显示器
  it('rebases drag ownership after the temporary display disconnects', () => {
    const displays = [makeDisplay(1, 0), makeDisplay(2, 1920), makeDisplay(3, 3840)]
    const win = relocateToDisplayTwo(displays)
    vi.clearAllMocks()

    // 承载窗口的显示器 2 被拔掉
    const connected = [displays[0], displays[2]]
    testState.displays = connected
    testState.blockerMap = new Map([[1, blocker(1)], [3, blocker(3)]])
    testState.dragging = { overlay: true, chat: false }
    testState.matchDisplay = () => displays[2]
    win.getBounds = () => ({ x: 3840, y: 0, width: 132, height: 132 })

    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, win as unknown as Electron.BrowserWindow)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

    // 每个程序化移动的目标都必须落在仍连着的显示器内
    for (const [, target] of vi.mocked(animateTo).mock.calls) {
      expect(intersectsConnectedWorkArea(target as Rect, connected)).toBe(true)
    }
    expect(intersectsConnectedWorkArea(win.getBounds(), connected)).toBe(true)
    // 不为已断开的显示器写偏好
    expect(setPreferredBoundsMock).not.toHaveBeenCalledWith('overlay', 2, expect.anything())
    expect(win.getBounds().x).not.toBe(1920)
  })

  // 回滚落点必须跟随当前落点；否则非法 drop 会被弹到窗口早已不在的地方
  describe('lastValidTemporaryPlacement 始终跟随 applied placement', () => {
    const PATHS = [
      {
        name: '自动避难落点',
        expectedX: 1920,
        // 当前落点保持空闲；否则回滚后窗口会因无处可去被挪走
        blocked: [1, 3],
        dropOnIndex: 2,
        settle: () => {},
      },
      {
        name: '用户拖到第三块屏后被接受的落点',
        expectedX: 3840,
        blocked: [1, 2],
        dropOnIndex: 1,
        settle: (win: ReturnType<typeof makeFakeOverlayWindow>, displays: ReturnType<typeof makeDisplay>[]) => {
          // 2 也挡住，让 3 成为唯一空闲屏；否则窗口会被挪回 2
          testState.blockerMap = new Map([[1, blocker(1)], [2, blocker(2)]])
          testState.dragging = { overlay: true, chat: false }
          testState.matchDisplay = () => displays[2]
          win.getBounds = () => ({ x: 3840, y: 0, width: 132, height: 132 })
          handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, win as unknown as Electron.BrowserWindow)
          vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)
        },
      },
    ]

    for (const path of PATHS) {
      it(`非法 drop 回到「${path.name}」`, () => {
        const displays = [makeDisplay(1, 0), makeDisplay(2, 1920), makeDisplay(3, 3840)]
        const win = relocateToDisplayTwo(displays)
        path.settle(win, displays)
        expect(win.getBounds().x).toBe(path.expectedX)
        vi.clearAllMocks()

        testState.blockerMap = new Map(path.blocked.map(id => [id, blocker(id)]))
        testState.dragging = { overlay: true, chat: false }
        const dropDisplay = displays[path.dropOnIndex]
        testState.matchDisplay = () => dropDisplay
        win.getBounds = () => ({ x: dropDisplay.bounds.x, y: 0, width: 132, height: 132 })

        handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, win as unknown as Electron.BrowserWindow)
        vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

        expect(win.getBounds().x).toBe(path.expectedX)
      })
    }
  })
})

describe('window behavior snapshot ordering', () => {
  const CONFIG_A = { chatPinMode: 'always' as const, petAvoidanceEnabled: true, petClickThrough: false, petCollapsed: false, appRules: [] }
  const CONFIG_B = { chatPinMode: 'off' as const, petAvoidanceEnabled: false, petClickThrough: false, petCollapsed: false, appRules: [{ exeName: 'x.exe', effect: 'hard' as const }] }

  it('applies a newer revision and rejects an older or equal one from the same generation', () => {
    expect(applyWindowBehaviorSnapshot({ generation: 'gen-order', revision: 5, config: CONFIG_A }, null, null)).toBe(true)
    expect(getCachedWindowBehaviorConfig()).toEqual(CONFIG_A)

    expect(applyWindowBehaviorSnapshot({ generation: 'gen-order', revision: 4, config: CONFIG_B }, null, null)).toBe(false)
    expect(applyWindowBehaviorSnapshot({ generation: 'gen-order', revision: 5, config: CONFIG_B }, null, null)).toBe(false)
    expect(getCachedWindowBehaviorConfig()).toEqual(CONFIG_A)

    expect(applyWindowBehaviorSnapshot({ generation: 'gen-order', revision: 6, config: CONFIG_B }, null, null)).toBe(true)
    expect(getCachedWindowBehaviorConfig()).toEqual(CONFIG_B)
  })

  it('accepts a different generation even with a lower revision', () => {
    applyWindowBehaviorSnapshot({ generation: 'gen-old', revision: 9, config: CONFIG_B }, null, null)

    expect(applyWindowBehaviorSnapshot({ generation: 'gen-new', revision: 1, config: CONFIG_A }, null, null)).toBe(true)
    expect(getCachedWindowBehaviorConfig()).toEqual(CONFIG_A)
  })

  it('initWindowBehaviorConfig applies the fetched snapshot through the same ordering rule', async () => {
    applyWindowBehaviorSnapshot({ generation: 'gen-init', revision: 7, config: CONFIG_A }, null, null)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ generation: 'gen-init', revision: 3, config: CONFIG_B }) })
      await initWindowBehaviorConfig(null, null)
      expect(getCachedWindowBehaviorConfig()).toEqual(CONFIG_A)

      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ generation: 'gen-init', revision: 8, config: CONFIG_B }) })
      await initWindowBehaviorConfig(null, null)
      expect(getCachedWindowBehaviorConfig()).toEqual(CONFIG_B)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('window behavior config acceptance re-observes the desktop', () => {
  const CONFIG = { chatPinMode: 'off' as const, petAvoidanceEnabled: true, petClickThrough: false, petCollapsed: false, appRules: [] }

  beforeEach(() => {
    requestObservationMock.mockClear()
  })

  it('applyWindowBehaviorSnapshot requests a forced observation when the snapshot is accepted', () => {
    expect(applyWindowBehaviorSnapshot({ generation: 'gen-obs', revision: 1, config: CONFIG }, null, null)).toBe(true)
    expect(requestObservationMock).toHaveBeenCalledTimes(1)
    expect(requestObservationMock).toHaveBeenCalledWith({ force: true })
  })

  it('applyWindowBehaviorSnapshot does not request an observation for a rejected snapshot', () => {
    applyWindowBehaviorSnapshot({ generation: 'gen-obs-rej', revision: 5, config: CONFIG }, null, null)
    requestObservationMock.mockClear()
    expect(applyWindowBehaviorSnapshot({ generation: 'gen-obs-rej', revision: 5, config: CONFIG }, null, null)).toBe(false)
    expect(requestObservationMock).not.toHaveBeenCalled()
  })

  it('initWindowBehaviorConfig requests a forced observation once the fetch settles, success or failure', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ generation: 'gen-obs-init', revision: 1, config: CONFIG }) })
      await initWindowBehaviorConfig(null, null)
      expect(requestObservationMock).toHaveBeenCalledTimes(1)
      expect(requestObservationMock).toHaveBeenLastCalledWith({ force: true })

      fetchMock.mockRejectedValueOnce(new Error('down'))
      await initWindowBehaviorConfig(null, null)
      expect(requestObservationMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('applyOverlaySize', () => {
  let fresh: typeof import('./windowBehavior')

  beforeEach(async () => {
    vi.resetModules()
    fresh = await import('./windowBehavior')
    await settleWindowBehaviorConfig(fresh)
  })

  afterEach(() => {
    getPreferredBoundsMock.mockReset()
    getPreferredBoundsMock.mockReturnValue(null)
  })

  function makeResizableOverlayWindow(bounds: { x: number; y: number; width: number; height: number }) {
    return { ...makeFakeOverlayWindow(bounds), setBounds: vi.fn() }
  }

  it('keeps the bottom edge anchored and leaves x to the edge controller while docked at an edge', () => {
    const display1 = makeDisplay(1, 0)
    testState.displays = [display1]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => display1
    testState.blockerMap = new Map()

    const win = makeResizableOverlayWindow({ x: -92, y: 900, width: 132, height: 132 })
    fresh.evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['user-rule']), severity: 'soft' }],
    ])
    fresh.evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    win.getBounds = () => ({ x: -92, y: 900, width: 132, height: 132 })
    vi.clearAllMocks()
    getPreferredBoundsMock.mockReturnValue({ x: -92, y: 900, width: 132, height: 132 })

    fresh.applyOverlaySize(win as unknown as Electron.BrowserWindow, { baseWidth: 300, baseHeight: 500, scale: 1 })

    expect(win.setBounds).toHaveBeenCalledWith({ x: -92, y: 532, width: 300, height: 500 })
  })

  it('resizes the window by the scale about the center of the bottom-anchored base rectangle, without writing preferred bounds', () => {
    const display1 = makeDisplay(1, 0)
    testState.displays = [display1]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => display1
    testState.blockerMap = new Map()

    const win = makeResizableOverlayWindow({ x: 1000, y: 800, width: 132, height: 132 })
    fresh.evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    vi.clearAllMocks()
    getPreferredBoundsMock.mockReturnValue({ x: 1000, y: 800, width: 132, height: 132 })

    fresh.applyOverlaySize(win as unknown as Electron.BrowserWindow, { baseWidth: 132, baseHeight: 132, scale: 1.5 })

    expect(win.setBounds).toHaveBeenCalledWith({ x: 967, y: 767, width: 198, height: 198 })
    expect(setPreferredBoundsMock).not.toHaveBeenCalled()
  })

  it('moveToDisplay sizes the window on the destination display from the last reported base size and scale', () => {
    const display1 = makeDisplay(1, 0)
    const display2 = makeDisplay(2, 1920)
    testState.displays = [display1, display2]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => display1
    testState.blockerMap = new Map()
    getPreferredBoundsMock.mockImplementation(((_key: string, displayId: number) =>
      displayId === 2 ? { x: 2600, y: 600, width: 132, height: 132 } : { x: 100, y: 600, width: 132, height: 132 }) as () => unknown)

    const win = makeResizableOverlayWindow({ x: 100, y: 600, width: 132, height: 132 })
    fresh.evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    fresh.applyOverlaySize(win as unknown as Electron.BrowserWindow, { baseWidth: 300, baseHeight: 500, scale: 1.5 })
    vi.clearAllMocks()

    testState.homeDisplayId = 2
    fresh.evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    expect(animateTo).toHaveBeenLastCalledWith(
      win,
      { x: 2441, y: 107, width: 450, height: 750 },
      expect.any(Function),
      { finalOpacity: 1 }
    )
  })

  it('reads preferred bounds under the applied display, not the display the window mostly overlaps, and never writes them', () => {
    const display1 = makeDisplay(1, 0)
    const display2 = makeDisplay(2, 1920)
    testState.displays = [display1, display2]
    testState.homeDisplayId = 2
    testState.matchDisplay = () => display1
    testState.blockerMap = new Map()

    const win = makeResizableOverlayWindow({ x: 2000, y: 900, width: 132, height: 132 })
    fresh.evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    win.getBounds = () => ({ x: 2000, y: 900, width: 132, height: 132 })
    vi.clearAllMocks()
    getPreferredBoundsMock.mockReturnValue({ x: 2000, y: 900, width: 132, height: 132 })

    fresh.applyOverlaySize(win as unknown as Electron.BrowserWindow, { baseWidth: 300, baseHeight: 500, scale: 1 })

    expect(getPreferredBoundsMock).toHaveBeenCalledWith('overlay', 2)
    expect(win.setBounds).toHaveBeenCalledWith({ x: 1920, y: 532, width: 300, height: 500 })
    expect(setPreferredBoundsMock).not.toHaveBeenCalled()
  })

  it('returns to the exact original bounds after resizing larger and back, even when the larger size is clamped', () => {
    const display1 = makeDisplay(1, 0)
    testState.displays = [display1]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => display1
    testState.blockerMap = new Map()

    const pixel = { x: 1920 - 132 - 100, y: 900, width: 132, height: 132 }
    const win = makeResizableOverlayWindow(pixel)
    fresh.evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    let current: { x: number; y: number; width: number; height: number } = { ...pixel }
    win.getBounds = () => current
    win.setBounds.mockImplementation((next: typeof current) => {
      current = { ...next }
    })
    vi.clearAllMocks()
    getPreferredBoundsMock.mockReturnValue({ ...pixel })

    try {
      for (const illustration of [{ width: 400, height: 500 }, { width: 401, height: 500 }]) {
        fresh.applyOverlaySize(win as unknown as Electron.BrowserWindow, { baseWidth: illustration.width, baseHeight: illustration.height, scale: 1 })
        expect(current.x).toBe(1920 - illustration.width)
        fresh.applyOverlaySize(win as unknown as Electron.BrowserWindow, { baseWidth: 132, baseHeight: 132, scale: 1 })
        expect(win.setBounds).toHaveBeenLastCalledWith(pixel)
        expect(current).toEqual(pixel)
      }
      expect(setPreferredBoundsMock).not.toHaveBeenCalled()
    } finally {
      getPreferredBoundsMock.mockReturnValue(null)
    }
  })
})

describe('pet interaction mode, collapsed handle geometry', () => {
  let fresh: typeof import('./windowBehavior')
  let revision = 0
  const PREFERRED = { x: 1500, y: 600, width: 132, height: 132 }
  const BASE_CONFIG = { chatPinMode: 'off' as const, petAvoidanceEnabled: true, petClickThrough: false, petCollapsed: false, appRules: [] }

  beforeEach(async () => {
    vi.resetModules()
    fresh = await import('./windowBehavior')
    await settleWindowBehaviorConfig(fresh)
    revision = 0
    testState.displays = [makeDisplay(1, 0)]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => testState.displays[0]
    testState.blockerMap = new Map()
    getPreferredBoundsMock.mockReturnValue({ ...PREFERRED })
  })

  afterEach(() => {
    getPreferredBoundsMock.mockReturnValue(null)
  })

  function makeModeWindow(bounds: { x: number; y: number; width: number; height: number }) {
    let opacity = 1
    const win = {
      ...makeFakeOverlayWindow(bounds),
      setBounds: vi.fn(),
      setShape: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
      getOpacity: () => opacity,
      setOpacity: vi.fn((value: number) => {
        opacity = value
      }),
    }
    win.setBounds.mockImplementation((next: typeof bounds) => {
      win.getBounds = () => next
    })
    return win
  }

  function asWindow(win: ReturnType<typeof makeModeWindow>): Electron.BrowserWindow {
    return win as unknown as Electron.BrowserWindow
  }

  function applyConfig(win: ReturnType<typeof makeModeWindow>, overrides: Partial<typeof BASE_CONFIG>): void {
    revision += 1
    fresh.applyWindowBehaviorSnapshot(
      { generation: 'mode-test', revision, config: { ...BASE_CONFIG, ...overrides } },
      null,
      asWindow(win)
    )
  }

  it('fills the new fields with false when an older core omits them', () => {
    const { petClickThrough: _a, petCollapsed: _b, ...legacy } = BASE_CONFIG
    fresh.applyWindowBehaviorSnapshot(
      { generation: 'legacy', revision: 1, config: legacy as unknown as typeof BASE_CONFIG },
      null,
      null
    )
    expect(fresh.getCachedWindowBehaviorConfig()).toMatchObject({ petClickThrough: false, petCollapsed: false })
  })

  it('touches neither mouse handling nor opacity in normal mode, however often it re-evaluates', () => {
    const win = makeModeWindow({ ...PREFERRED })
    fresh.evaluateDesktopPresence(null, asWindow(win))
    fresh.evaluateDesktopPresence(null, asWindow(win))

    expect(win.setIgnoreMouseEvents).not.toHaveBeenCalled()
    expect(win.setOpacity).not.toHaveBeenCalled()
  })

  it('click-through ignores the mouse as a whole window and dims to 0.6 exactly once, then restores once on leaving it', () => {
    const win = makeModeWindow({ ...PREFERRED })
    fresh.evaluateDesktopPresence(null, asWindow(win))

    applyConfig(win, { petClickThrough: true })
    fresh.evaluateDesktopPresence(null, asWindow(win))

    expect(win.setIgnoreMouseEvents).toHaveBeenCalledTimes(1)
    expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(true)
    expect(win.setOpacity).toHaveBeenCalledTimes(1)
    expect(win.setOpacity).toHaveBeenCalledWith(0.6)

    applyConfig(win, { petClickThrough: false })

    expect(win.setIgnoreMouseEvents).toHaveBeenCalledTimes(2)
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)
    expect(win.setOpacity).toHaveBeenCalledTimes(2)
    expect(win.setOpacity).toHaveBeenLastCalledWith(1)
  })

  it('collapsed accepts the mouse at full opacity, and wins over click-through', () => {
    const win = makeModeWindow({ ...PREFERRED })
    fresh.evaluateDesktopPresence(null, asWindow(win))

    applyConfig(win, { petCollapsed: true, petClickThrough: true })

    expect(win.setIgnoreMouseEvents).not.toHaveBeenCalled()
    expect(win.setOpacity).not.toHaveBeenCalled()
    expect(fresh.getCurrentPetMode()).toBe('collapsed')
  })

  it('moveToDisplay and edge animations end at the current mode target opacity', () => {
    testState.displays = [makeDisplay(1, 0), makeDisplay(2, 1920)]
    testState.homeDisplayId = 2
    const win = makeModeWindow({ ...PREFERRED })

    fresh.evaluateDesktopPresence(null, asWindow(win))
    expect(animateTo).toHaveBeenLastCalledWith(asWindow(win), expect.anything(), expect.any(Function), { finalOpacity: 1 })

    testState.homeDisplayId = 1
    applyConfig(win, { petClickThrough: true })
    fresh.evaluateDesktopPresence(null, asWindow(win))
    expect(animateTo).toHaveBeenLastCalledWith(asWindow(win), expect.anything(), expect.any(Function), { finalOpacity: 0.6 })
  })

  it('collapse sets the 24x24 handle bounds and expand restores the expanded bounds, never writing preferred bounds', () => {
    const win = makeModeWindow({ ...PREFERRED })
    fresh.evaluateDesktopPresence(null, asWindow(win))
    win.setBounds.mockClear()
    setPreferredBoundsMock.mockClear()

    applyConfig(win, { petCollapsed: true })
    expect(win.setBounds).toHaveBeenCalledTimes(1)
    expect(win.setBounds).toHaveBeenLastCalledWith({ x: 1500 + 132 - 24, y: 600, width: 24, height: 24 })

    applyConfig(win, { petCollapsed: false })
    expect(win.setBounds).toHaveBeenCalledTimes(2)
    expect(win.setBounds).toHaveBeenLastCalledWith(PREFERRED)
    expect(setPreferredBoundsMock).not.toHaveBeenCalled()
  })

  it('while collapsed a set-size report repositions only the handle and never expands the window', () => {
    const win = makeModeWindow({ ...PREFERRED })
    fresh.evaluateDesktopPresence(null, asWindow(win))
    fresh.applyOverlaySize(asWindow(win), { baseWidth: 200, baseHeight: 200, scale: 1 })
    applyConfig(win, { petCollapsed: true })
    win.setBounds.mockClear()

    fresh.applyOverlaySize(asWindow(win), { baseWidth: 300, baseHeight: 300, scale: 1 })
    expect(win.setBounds).toHaveBeenCalledTimes(1)
    expect(win.setBounds).toHaveBeenLastCalledWith({ x: 1500 + (132 - 300) / 2 + 300 - 24, y: 600 + 132 - 300, width: 24, height: 24 })

    win.setBounds.mockClear()
    fresh.applyOverlaySize(asWindow(win), { baseWidth: 300, baseHeight: 300, scale: 1 })
    expect(win.setBounds).not.toHaveBeenCalled()

    applyConfig(win, { petCollapsed: false })
    expect(win.setBounds).toHaveBeenCalledTimes(1)
    expect(win.setBounds).toHaveBeenLastCalledWith({ x: 1500 + (132 - 300) / 2, y: 600 + 132 - 300, width: 300, height: 300 })
  })

  it('while collapsed and docked at an edge a set-size report keeps the handle x and moves only y', () => {
    const win = makeModeWindow({ ...PREFERRED })
    fresh.evaluateDesktopPresence(null, asWindow(win))
    applyConfig(win, { petCollapsed: true })
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['user-rule']), severity: 'soft' }],
    ])
    fresh.evaluateDesktopPresence(null, asWindow(win))
    win.setBounds.mockClear()

    fresh.applyOverlaySize(asWindow(win), { baseWidth: 132, baseHeight: 132, scale: 1.5 })

    expect(win.setBounds).toHaveBeenCalledWith({ x: 1920 - 40, y: 567, width: 24, height: 24 })
  })

  function relocateWithCancelSpy(win: ReturnType<typeof makeModeWindow>): { cancel: ReturnType<typeof vi.fn>; target: { x: number; y: number; width: number; height: number } } {
    const cancel = vi.fn()
    let target = { x: 0, y: 0, width: 0, height: 0 }
    testState.displays = [makeDisplay(1, 0), makeDisplay(2, 1920)]
    vi.mocked(animateTo).mockImplementationOnce((w, t, onComplete) => {
      target = t as typeof target
      ;(w as unknown as { getBounds: () => unknown }).getBounds = () => t
      onComplete?.()
      return cancel
    })
    testState.homeDisplayId = 2
    fresh.evaluateDesktopPresence(null, asWindow(win))
    return { cancel, target }
  }

  it('a collapsed set-size report with the handle already at its x and y neither moves the window nor cancels the animation, even when Windows enlarged it to 27x28', () => {
    const win = makeModeWindow({ ...PREFERRED })
    fresh.evaluateDesktopPresence(null, asWindow(win))
    fresh.applyOverlaySize(asWindow(win), { baseWidth: 132, baseHeight: 132, scale: 1 })
    applyConfig(win, { petCollapsed: true })
    const { cancel, target } = relocateWithCancelSpy(win)
    win.getBounds = () => ({ x: target.x, y: target.y, width: 27, height: 28 })
    win.setBounds.mockClear()

    fresh.applyOverlaySize(asWindow(win), { baseWidth: 132, baseHeight: 132, scale: 1 })

    expect(win.setBounds).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()

    fresh.applyOverlaySize(asWindow(win), { baseWidth: 200, baseHeight: 200, scale: 1 })

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(win.setBounds).toHaveBeenCalledTimes(1)
  })

  it('an unchanged non-collapsed set-size report neither moves the window nor cancels the animation, but a changed one cancels it first', () => {
    const win = makeModeWindow({ ...PREFERRED })
    fresh.evaluateDesktopPresence(null, asWindow(win))
    fresh.applyOverlaySize(asWindow(win), { baseWidth: 132, baseHeight: 132, scale: 1 })
    const { cancel } = relocateWithCancelSpy(win)
    win.setBounds.mockClear()

    fresh.applyOverlaySize(asWindow(win), { baseWidth: 132, baseHeight: 132, scale: 1 })

    expect(win.setBounds).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()

    fresh.applyOverlaySize(asWindow(win), { baseWidth: 132, baseHeight: 132, scale: 1.5 })

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(win.setBounds).toHaveBeenCalledTimes(1)
  })

  it('a collapsed set-size report never writes preferred bounds', () => {
    const win = makeModeWindow({ ...PREFERRED })
    fresh.evaluateDesktopPresence(null, asWindow(win))
    applyConfig(win, { petCollapsed: true })
    setPreferredBoundsMock.mockClear()

    fresh.applyOverlaySize(asWindow(win), { baseWidth: 300, baseHeight: 300, scale: 1.5 })
    fresh.applyOverlaySize(asWindow(win), { baseWidth: 200, baseHeight: 200, scale: 1 })

    expect(win.setBounds).toHaveBeenCalled()
    expect(setPreferredBoundsMock).not.toHaveBeenCalled()
  })

  it('moveToDisplay writes a missing remembered position whose size equals the reported base size', () => {
    testState.displays = [makeDisplay(1, 0), makeDisplay(2, 1920)]
    getPreferredBoundsMock.mockImplementation(((_key: string, displayId: number) =>
      displayId === 2 ? null : { ...PREFERRED }) as () => unknown)
    const win = makeModeWindow({ ...PREFERRED })
    fresh.evaluateDesktopPresence(null, asWindow(win))
    fresh.applyOverlaySize(asWindow(win), { baseWidth: 300, baseHeight: 500, scale: 1.5 })
    setPreferredBoundsMock.mockClear()

    testState.homeDisplayId = 2
    fresh.evaluateDesktopPresence(null, asWindow(win))

    expect(setPreferredBoundsMock).toHaveBeenCalledWith('overlay', 2, { x: 1995, y: 125, width: 300, height: 500 })
  })

  it('persists a dragged window as the unscaled remembered position', () => {
    const win = makeModeWindow({ ...PREFERRED })
    fresh.evaluateDesktopPresence(null, asWindow(win))
    fresh.applyOverlaySize(asWindow(win), { baseWidth: 132, baseHeight: 132, scale: 1.5 })
    setPreferredBoundsMock.mockClear()

    testState.dragging = { overlay: true, chat: false }
    win.getBounds = () => ({ x: 1000, y: 300, width: 198, height: 198 })
    fresh.handleWindowMoved('overlay', asWindow(win), null, null)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

    expect(setPreferredBoundsMock).toHaveBeenCalledWith('overlay', 1, { x: 1033, y: 333, width: 132, height: 132 })
  })

  it('persists a dragged collapsed handle as the unscaled remembered position implied by the scaled window', () => {
    const win = makeModeWindow({ ...PREFERRED })
    fresh.evaluateDesktopPresence(null, asWindow(win))
    fresh.applyOverlaySize(asWindow(win), { baseWidth: 132, baseHeight: 132, scale: 1.5 })
    applyConfig(win, { petCollapsed: true })
    setPreferredBoundsMock.mockClear()

    testState.dragging = { overlay: true, chat: false }
    win.getBounds = () => ({ x: 1000, y: 300, width: 24, height: 24 })
    fresh.handleWindowMoved('overlay', asWindow(win), null, null)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

    expect(setPreferredBoundsMock).toHaveBeenCalledWith('overlay', 1, { x: 1000 - (198 - 24) + 33, y: 300 + 33, width: 132, height: 132 })
  })

  it('uses the preferred bounds size for the first expand when no size was ever reported', () => {
    const win = makeModeWindow({ x: 1608, y: 600, width: 24, height: 24 })
    fresh.noteOverlayCreatedCollapsed(true)
    applyConfig(win, { petCollapsed: true })

    expect(win.setBounds).not.toHaveBeenCalled()
    expect(animateTo).toHaveBeenLastCalledWith(
      asWindow(win),
      { x: 1608, y: 600, width: 24, height: 24 },
      expect.any(Function),
      { finalOpacity: 1 }
    )

    win.setBounds.mockClear()
    applyConfig(win, { petCollapsed: false })
    expect(win.setBounds).toHaveBeenLastCalledWith(PREFERRED)
  })

  it('moveToDisplay targets the handle bounds of the destination display while collapsed', () => {
    testState.displays = [makeDisplay(1, 0), makeDisplay(2, 1920)]
    testState.homeDisplayId = 2
    getPreferredBoundsMock.mockImplementation(((_key: string, displayId: number) =>
      displayId === 2 ? { x: 2000, y: 600, width: 132, height: 132 } : null) as () => unknown)
    const win = makeModeWindow({ x: 0, y: 0, width: 132, height: 132 })

    applyConfig(win, { petCollapsed: true })

    expect(animateTo).toHaveBeenLastCalledWith(
      asWindow(win),
      { x: 2000 + 132 - 24, y: 600, width: 24, height: 24 },
      expect.any(Function),
      { finalOpacity: 1 }
    )
  })

  it('edge restore on hover maps the full bounds computed with the pet size onto the handle, and the handle never reports handleSuppressed', () => {
    const win = makeModeWindow({ ...PREFERRED })
    fresh.evaluateDesktopPresence(null, asWindow(win))
    applyConfig(win, { petCollapsed: true })

    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['user-rule']), severity: 'soft' }],
    ])
    fresh.evaluateDesktopPresence(null, asWindow(win))
    expect(animateTo).toHaveBeenLastCalledWith(
      asWindow(win),
      { x: 1920 - 40, y: 600, width: 24, height: 24 },
      expect.any(Function),
      { finalOpacity: 1 }
    )
    expect(win.webContents.send).toHaveBeenLastCalledWith(
      'desktop-presence:changed',
      expect.objectContaining({ presence: 'EDGE', collapsed: true, handleSuppressed: false })
    )

    fresh.requestOverlayEdgeHover(asWindow(win), true)
    expect(animateTo).toHaveBeenLastCalledWith(
      asWindow(win),
      { x: 1500 + 132 - 24, y: 600, width: 24, height: 24 },
      expect.any(Function),
      { finalOpacity: 1 }
    )
  })

  it('persists a dragged handle as the expanded bounds it implies, not as a 24x24 box', () => {
    const win = makeModeWindow({ ...PREFERRED })
    fresh.evaluateDesktopPresence(null, asWindow(win))
    applyConfig(win, { petCollapsed: true })
    setPreferredBoundsMock.mockClear()

    testState.dragging = { overlay: true, chat: false }
    win.getBounds = () => ({ x: 1000, y: 300, width: 24, height: 24 })
    fresh.handleWindowMoved('overlay', asWindow(win), null, null)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

    expect(setPreferredBoundsMock).toHaveBeenCalledWith('overlay', 1, { x: 1000 - (132 - 24), y: 300, width: 132, height: 132 })
  })

  it('broadcasts the configured collapsed and clickThrough flags', () => {
    const win = makeModeWindow({ ...PREFERRED })
    fresh.evaluateDesktopPresence(null, asWindow(win))

    applyConfig(win, { petClickThrough: true })
    expect(win.webContents.send).toHaveBeenLastCalledWith(
      'desktop-presence:changed',
      expect.objectContaining({ collapsed: false, clickThrough: true })
    )

    applyConfig(win, { petClickThrough: true, petCollapsed: true })
    expect(win.webContents.send).toHaveBeenLastCalledWith(
      'desktop-presence:changed',
      expect.objectContaining({ collapsed: true, clickThrough: true })
    )
  })
  function makeVisibleModeWindow(bounds: { x: number; y: number; width: number; height: number }) {
    let visible = false
    const win = makeModeWindow(bounds)
    win.isVisible = () => visible
    win.showInactive = vi.fn(() => {
      visible = true
    })
    win.hide = vi.fn(() => {
      visible = false
    })
    return win
  }

  function makeHandleWindow() {
    let visible = false
    return {
      isDestroyed: () => false,
      isVisible: () => visible,
      showInactive: vi.fn(() => {
        visible = true
      }),
      hide: vi.fn(() => {
        visible = false
      }),
      setBounds: vi.fn(),
    }
  }

  function attachHandle(handle: ReturnType<typeof makeHandleWindow>): void {
    fresh.setPetHandleWindow(handle as unknown as Electron.BrowserWindow)
  }

  it('shows the handle window only while click-through and the pet window is visible', () => {
    const win = makeVisibleModeWindow({ ...PREFERRED })
    const handle = makeHandleWindow()
    attachHandle(handle)

    fresh.evaluateDesktopPresence(null, asWindow(win))
    expect(handle.showInactive).not.toHaveBeenCalled()

    applyConfig(win, { petClickThrough: true })
    expect(handle.showInactive).toHaveBeenCalledTimes(1)
    expect(handle.setBounds).toHaveBeenLastCalledWith({ x: 1500 + 132 - 24, y: 600, width: 24, height: 24 })

    fresh.evaluateDesktopPresence(null, asWindow(win))
    expect(handle.showInactive).toHaveBeenCalledTimes(1)

    applyConfig(win, { petClickThrough: false })
    expect(handle.hide).toHaveBeenCalledTimes(1)
  })

  it('hides the handle window while the pet window is hidden', () => {
    const win = makeVisibleModeWindow({ ...PREFERRED })
    const handle = makeHandleWindow()
    attachHandle(handle)
    applyConfig(win, { petClickThrough: true })
    expect(handle.isVisible()).toBe(true)

    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    fresh.evaluateDesktopPresence(null, asWindow(win))

    expect(win.hide).toHaveBeenCalled()
    expect(handle.isVisible()).toBe(false)
  })

  it('hides the handle window when collapsed, since the pet window itself is the handle', () => {
    const win = makeVisibleModeWindow({ ...PREFERRED })
    const handle = makeHandleWindow()
    attachHandle(handle)
    applyConfig(win, { petClickThrough: true })
    expect(handle.isVisible()).toBe(true)

    applyConfig(win, { petClickThrough: true, petCollapsed: true })
    expect(handle.isVisible()).toBe(false)
  })

  it('keeps the handle window shown during EDGE', () => {
    const win = makeVisibleModeWindow({ ...PREFERRED })
    const handle = makeHandleWindow()
    attachHandle(handle)
    applyConfig(win, { petClickThrough: true })

    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['user-rule']), severity: 'soft' }],
    ])
    fresh.evaluateDesktopPresence(null, asWindow(win))

    expect(win.webContents.send).toHaveBeenLastCalledWith(
      'desktop-presence:changed',
      expect.objectContaining({ presence: 'EDGE', handleSuppressed: true })
    )
    expect(handle.isVisible()).toBe(true)
    expect(handle.hide).not.toHaveBeenCalled()
  })

  it('defers a collapse requested during an overlay drag until the drag ends', () => {
    const win = makeModeWindow({ ...PREFERRED })
    fresh.evaluateDesktopPresence(null, asWindow(win))

    testState.dragging = { overlay: true, chat: false }
    applyConfig(win, { petCollapsed: true })

    expect(fresh.getCurrentPetMode()).toBe('normal')
    expect(win.setShape).not.toHaveBeenCalled()
    expect(win.webContents.send).toHaveBeenLastCalledWith(
      'desktop-presence:changed',
      expect.objectContaining({ collapsed: false })
    )

    testState.dragging = { overlay: false, chat: false }
    fresh.evaluateDesktopPresence(null, asWindow(win))

    expect(fresh.getCurrentPetMode()).toBe('collapsed')
    expect(win.setShape).toHaveBeenLastCalledWith([{ x: 0, y: 0, width: 24, height: 24 }])
    expect(win.webContents.send).toHaveBeenLastCalledWith(
      'desktop-presence:changed',
      expect.objectContaining({ collapsed: true })
    )
  })

  it('clips the pet window to the 24x24 handle region on collapse and clears the shape on expand', () => {
    const win = makeModeWindow({ ...PREFERRED })
    fresh.evaluateDesktopPresence(null, asWindow(win))
    expect(win.setShape).not.toHaveBeenCalled()

    applyConfig(win, { petCollapsed: true })
    expect(win.setShape).toHaveBeenLastCalledWith([{ x: 0, y: 0, width: 24, height: 24 }])

    applyConfig(win, { petCollapsed: false })
    expect(win.setShape).toHaveBeenLastCalledWith([])
  })
})

describe('collapsed pet shape follows the display scale', () => {
  let fresh: typeof import('./windowBehavior')
  let revision = 0
  const PREFERRED = { x: 1500, y: 600, width: 132, height: 132 }
  const HANDLE = [{ x: 0, y: 0, width: 24, height: 24 }]

  beforeEach(async () => {
    vi.resetModules()
    fresh = await import('./windowBehavior')
    await settleWindowBehaviorConfig(fresh)
    revision = 0
    testState.displays = [makeDisplay(1, 0)]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => testState.displays[0]
    testState.blockerMap = new Map()
    getPreferredBoundsMock.mockReturnValue({ ...PREFERRED })
  })

  afterEach(() => {
    getPreferredBoundsMock.mockReturnValue(null)
  })

  function makeWindow() {
    const win = {
      ...makeFakeOverlayWindow({ ...PREFERRED }),
      setBounds: vi.fn(),
      setShape: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
      getOpacity: () => 1,
      setOpacity: vi.fn(),
    }
    win.setBounds.mockImplementation((next: typeof PREFERRED) => {
      win.getBounds = () => next
    })
    return win
  }

  function asWindow(win: ReturnType<typeof makeWindow>): Electron.BrowserWindow {
    return win as unknown as Electron.BrowserWindow
  }

  function setCollapsed(win: ReturnType<typeof makeWindow>, petCollapsed: boolean): void {
    revision += 1
    fresh.applyWindowBehaviorSnapshot(
      {
        generation: 'shape-test',
        revision,
        config: { chatPinMode: 'off', petAvoidanceEnabled: true, petClickThrough: false, petCollapsed, appRules: [] },
      },
      null,
      asWindow(win)
    )
  }

  it('does not set the shape again while the scale is unchanged', () => {
    const win = makeWindow()
    fresh.evaluateDesktopPresence(null, asWindow(win))
    setCollapsed(win, true)
    expect(win.setShape).toHaveBeenCalledTimes(1)

    fresh.recheckPetShapeScale(asWindow(win))
    fresh.evaluateDesktopPresence(null, asWindow(win))
    expect(win.setShape).toHaveBeenCalledTimes(1)
  })

  it('sets the original rectangle once after the scale changes', () => {
    const win = makeWindow()
    fresh.evaluateDesktopPresence(null, asWindow(win))
    setCollapsed(win, true)
    win.setShape.mockClear()

    testState.displays[0].scaleFactor = 1.5
    fresh.recheckPetShapeScale(asWindow(win))
    expect(win.setShape).toHaveBeenCalledTimes(1)
    expect(win.setShape).toHaveBeenLastCalledWith(HANDLE)

    fresh.evaluateDesktopPresence(null, asWindow(win))
    fresh.recheckPetShapeScale(asWindow(win))
    expect(win.setShape).toHaveBeenCalledTimes(1)
  })

  it('reapplies from the presence evaluation after a display change', () => {
    const win = makeWindow()
    fresh.evaluateDesktopPresence(null, asWindow(win))
    setCollapsed(win, true)
    win.setShape.mockClear()

    testState.displays[0].scaleFactor = 2
    fresh.evaluateDesktopPresence(null, asWindow(win))
    expect(win.setShape).toHaveBeenCalledTimes(1)
    expect(win.setShape).toHaveBeenLastCalledWith(HANDLE)
  })

  it('never sets the shape of an expanded pet when the scale changes', () => {
    const win = makeWindow()
    fresh.evaluateDesktopPresence(null, asWindow(win))
    setCollapsed(win, true)
    setCollapsed(win, false)
    win.setShape.mockClear()

    testState.displays[0].scaleFactor = 1.5
    fresh.recheckPetShapeScale(asWindow(win))
    fresh.evaluateDesktopPresence(null, asWindow(win))
    expect(win.setShape).not.toHaveBeenCalled()
  })

  it('records the scale when the window was created collapsed', () => {
    const win = makeWindow()
    fresh.noteOverlayCreatedCollapsed(true)
    fresh.notePetShapeApplied(asWindow(win))

    testState.displays[0].scaleFactor = 1.5
    fresh.recheckPetShapeScale(asWindow(win))
    expect(win.setShape).toHaveBeenCalledTimes(1)
    expect(win.setShape).toHaveBeenLastCalledWith(HANDLE)
  })
})

describe('startup gate on the first window-behavior config fetch', () => {
  let fresh: typeof import('./windowBehavior')

  beforeEach(async () => {
    vi.resetModules()
    fresh = await import('./windowBehavior')
    fresh.armPetSizeGate(null)
    vi.advanceTimersByTime(3000)
    testState.displays = [makeDisplay(1, 0)]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => testState.displays[0]
    testState.blockerMap = new Map()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not evaluate the pet before the first fetch settles', () => {
    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })

    fresh.evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    expect(win.showInactive).not.toHaveBeenCalled()
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('proceeds with defaults after a failed or timed-out fetch, bounded by an abort signal', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('aborted'))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })

    await fresh.initWindowBehaviorConfig(null, win as unknown as Electron.BrowserWindow)

    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    expect(win.showInactive).toHaveBeenCalled()
  })

  it('proceeds with the fetched config after a successful fetch', async () => {
    const config = { chatPinMode: 'off', petAvoidanceEnabled: true, petClickThrough: true, petCollapsed: false, appRules: [] }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ generation: 'g', revision: 1, config }) }))
    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })

    await fresh.initWindowBehaviorConfig(null, win as unknown as Electron.BrowserWindow)

    expect(win.webContents.send).toHaveBeenLastCalledWith(
      'desktop-presence:changed',
      expect.objectContaining({ clickThrough: true })
    )
  })
})

describe('startup pet size gate', () => {
  let fresh: typeof import('./windowBehavior')

  beforeEach(async () => {
    vi.resetModules()
    fresh = await import('./windowBehavior')
    await settleConfigOnly(fresh)
    testState.displays = [makeDisplay(1, 0)]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => testState.displays[0]
    testState.blockerMap = new Map()
  })

  function makeSizedWindow() {
    return { ...makeFakeOverlayWindow({ x: 100, y: 600, width: 132, height: 132 }), setBounds: vi.fn() }
  }

  it('does not show the overlay before the first size report, even with the config settled', () => {
    const win = makeSizedWindow()
    fresh.armPetSizeGate(win as unknown as Electron.BrowserWindow)

    fresh.evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    expect(win.showInactive).not.toHaveBeenCalled()
  })

  it('shows the overlay once the first size report arrives', () => {
    const win = makeSizedWindow()
    fresh.armPetSizeGate(win as unknown as Electron.BrowserWindow)

    fresh.applyOverlaySize(win as unknown as Electron.BrowserWindow, { baseWidth: 132, baseHeight: 132, scale: 1 })

    expect(win.showInactive).toHaveBeenCalled()
  })

  it('shows the overlay at the current size when no size report arrives within 3000 ms', () => {
    const win = makeSizedWindow()
    fresh.armPetSizeGate(win as unknown as Electron.BrowserWindow)

    vi.advanceTimersByTime(2999)
    expect(win.showInactive).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(win.showInactive).toHaveBeenCalled()
  })
})
