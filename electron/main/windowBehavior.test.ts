import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Second rework pass, Fix A / Fix C: these two regressions live in windowBehavior.ts's own
// stateful orchestration (programmaticMoveInFlight/programmaticQuietUntil for Fix A,
// appliedDisplayIdFor for Fix C), not in any pure function extracted to desktopPresence.ts. The
// established convention in this file set is "only test pure functions, orchestration needs real
// Electron" (see windowPositions.test.ts/foregroundWorldModel.test.ts head comments, and the
// now-deleted previous windowBehavior.test.ts that tested the old decideDodge/decideDodgeClear
// functions before they were replaced by desktopPresence.ts's pure resolvers). Fix A and Fix C are
// deliberately exceptions: the mandatory sanity check for this rework pass requires a test that
// goes RED when either fix is reverted, and neither regression is reachable through any pure
// function alone (deriveDragContext's appliedDisplayId===null handling was already correct before
// Fix C; isProgrammaticMoveEcho as a pure classifier is correct regardless of whether its call
// site in handleWindowMoved actually early-returns). So this file mocks every one of
// windowBehavior.ts's dependencies (electron itself, plus windowPositions/homeDisplayCommit/
// foregroundWorldModel/windowAnimation/dragActivity) and exercises the real windowBehavior.ts
// module end to end, keeping desktopPresence.ts's real pure functions in the loop since that is
// exactly the logic being integrated.
//
// ---------------------------------------------------------------------------------------------
// 本文件的范围约定（用户明确指示，不是建议）
// ---------------------------------------------------------------------------------------------
// 这个文件**保留**，因为窗口策略已经积累了不少跨状态约束，纯函数层覆盖不到"最后有没有对
// BrowserWindow 调用错行为"这一层。但它的范围必须被压住：
//
//   只放少量 high-value 的回归 sanity check——即那些保护一条**明确的不变量**、
//   且在纯函数层无论如何都测不到的用例。
//
//   **不要**让它逐渐长成一整套 mock 版的编排测试。测 Electron 实现细节（某个 API 被调了几次、
//   参数长什么样）不属于这里；那种测试只会把 mock 本身钉死，日后每次重构都要陪着改，
//   却挡不住任何真实回归。
//
// 新增用例前先自问：这条不变量能不能在 desktopPresence.ts / displayStateMap.ts 这类纯函数层
// 测到？能，就放那边。不能，且它保护的是一条真实出过或差点出过的回归——才放这里。

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
  // Fix 1 (second rework pass): dragActivity.ts's state is now per-window — this test file's
  // mock mirrors that shape so FIX 1's per-window tests (below) can drive each window
  // independently, rather than the single shared boolean the old isUserDragInProgress() mock used.
  dragging: { overlay: false, chat: false } as Record<'overlay' | 'chat', boolean>,
}))

const { revalidateBlockersNowMock, setPreferredBoundsMock } = vi.hoisted(() => ({
  revalidateBlockersNowMock: vi.fn(),
  setPreferredBoundsMock: vi.fn(),
}))

vi.mock('electron', () => ({
  screen: {
    getAllDisplays: () => testState.displays,
    getDisplayMatching: (bounds: unknown) => testState.matchDisplay(bounds),
  },
  BrowserWindow: class {},
}))

vi.mock('./windowPositions', () => ({
  getPreferredBounds: () => null,
  setPreferredBounds: setPreferredBoundsMock,
  getEffectiveHomeDisplay: (displays: typeof testState.displays) => {
    const home = displays.find(d => d.id === testState.homeDisplayId)
    if (home) return home
    // Mirrors the real resolveStartupDisplay fallback (pick the largest connected display) —
    // a faithful-enough stand-in for this test's purposes, see windowPositions.ts.
    return displays.reduce((a, b) => (a.bounds.width * a.bounds.height >= b.bounds.width * b.bounds.height ? a : b))
  },
  computeDefaultBoundsForDisplay: (display: { bounds: { x: number; y: number } }) => ({
    x: display.bounds.x,
    y: display.bounds.y,
    width: 132,
    height: 132,
  }),
  DEFAULT_WINDOW_SIZE: { chat: { width: 290, height: 520 }, overlay: { width: 132, height: 132 } },
  // Fix 4 (second rework pass): windowBehavior.ts now imports this from windowPositions.ts
  // instead of defining its own local copy — the mock must provide it. Kept equal to this file's
  // own local PERSIST_DEBOUNCE_MS constant below (used for this file's own timer arithmetic).
  PERSIST_DEBOUNCE_MS: 300,
}))

vi.mock('./homeDisplayCommit', () => ({
  commitHomeDisplayFromDragOutcome: vi.fn(),
}))

vi.mock('./foregroundWorldModel', () => ({
  getDisplayStateMap: () => testState.blockerMap,
  revalidateBlockersNow: revalidateBlockersNowMock,
}))

vi.mock('./windowAnimation', () => ({
  // Real animateTo runs an async exit/teleport/entrance sequence; the tests below don't need to
  // exercise that sequence itself (windowAnimation.test.ts already covers its pure pieces, and
  // this file is about windowBehavior.ts's own state, not animateTo's internals) — completing
  // synchronously keeps these tests from needing to fight two independent timer sequences.
  // Wrapped in vi.fn (rather than a bare arrow function) so FIX 1/FIX 6's tests below can assert
  // on whether a relocate actually happened, not just infer it indirectly.
  //
  // Resolver/Controller 边界修正之后新增的一行：settle 之后无条件重新走一遍
  // evaluatePetPresence 是这个模型要求的收敛义务（见 settlePetPresence 定义处注释），而收敛
  // 靠的是重新读一次 win.getBounds() 判断"是否已经到位"——真实的 animateTo 会真的
  // win.setBounds(target)，此处的 fake win 只是普通对象，getBounds() 是构造时闭包住的静态值，
  // 不会自己跟着动。若这里不模拟这一步，"落定后再收敛一次"的检查会永远读到搬家前的旧
  // bounds、判定"还没到位"，从而无限重复排队同一个目标的动画——这正是本文件里数个 EDGE 测试
  // 曾经各自手写 `win.getBounds = () => ({...})` 来модел的同一件事，这里把它上提到默认 mock
  // 本身，让它对所有没有用 mockImplementationOnce 覆盖默认行为的调用点都成立，不需要每个
  // 测试各自记得补一行
  animateTo: vi.fn((win: { getBounds: () => unknown }, target: unknown, onComplete?: () => void) => {
    win.getBounds = () => target
    onComplete?.()
    return () => {}
  }),
}))

vi.mock('./dragActivity', () => ({
  // Fix 1 (second rework pass): per-window, driven by testState.dragging — see that field's
  // comment. The real isWindowDragInProgress(windowKey) signature.
  isWindowDragInProgress: (windowKey: 'overlay' | 'chat') => testState.dragging[windowKey],
  // 真实实现只收掉松手尾巴；在这个 mock 里 testState.dragging 就代表
  // isWindowDragInProgress 的结果，所以置 false 等价
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
  updateCachedWindowBehaviorConfig,
  requestOverlayEdgeHover,
  sendCurrentPetPresenceOnReady,
  closeStartupGate,
  openStartupGate,
  cancelProgrammaticMoveOnDragStart,
} from './windowBehavior'

// Same durations as windowBehavior.ts. PERSIST_DEBOUNCE_MS is exported from windowPositions.ts
// (Fix 4) and re-provided by this file's own vi.mock('./windowPositions', ...) above (kept equal
// to this local copy) — this local copy exists purely for this file's own setTimeout arithmetic
// (advancing fake timers past it), a different concern from the dragActivity.ts duplication Fix 4
// closes.
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
    showInactive: vi.fn(),
    hide: vi.fn(),
    // evaluatePetPresence now applies the pet's always-on-top through the same PIN_LEVEL path as
    // the chat window (see windowBehavior.ts applyAlwaysOnTop) — previously the overlay's topmost
    // state was only set once at construction in index.ts, at Electron's default 'floating' level.
    setAlwaysOnTop: vi.fn(),
    getBounds: () => bounds,
    // Stage 3 part 2: evaluatePetPresence now broadcasts the current presence to the overlay's
    // own webContents (see windowBehavior.ts broadcastPetPresenceIfChanged) — the real
    // BrowserWindow always has this, so the fake must too.
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

// programmaticMoveInFlight/programmaticQuietUntil (windowBehavior.ts) are module-level state,
// not reset between tests by vi.clearAllMocks(). A previous test's markProgrammaticWindowPlacement
// (PROGRAMMATIC_MOVE_COOLDOWN_MS = 1000ms) could otherwise still read as "quiet" at the start of
// the next test. Each test gets its own fixed, monotonically-increasing fake "now" — far enough
// apart (100s) that no cooldown/tail constant used anywhere in windowBehavior.ts can bridge two
// tests — rather than relying on real wall-clock gaps between fake-timer installs, which is not
// guaranteed to be large enough (and wasn't, in practice: see this file's history).
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

// FIX 3 (second rework pass): sendCurrentPetPresenceOnReady previously had zero test coverage —
// its race-freedom argument rested only on a comment.
//
// 关于 lastBroadcastPetPresence 这份模块状态：它跨测试存活（与本文件里
// appliedPetDisplayId/programmaticMoveInFlight 同一类问题），因此"从未广播过"这个原始状态
// 本来只能靠"把这个 describe 放在文件最前面"来保证。那是一条**只写在注释里**的约束——编译器
// 和测试框架都不会替你守住它，以后有人在上面插一个 describe，(b) 就会静默地不再测它声称要测
// 的东西（review 明确点出了这一点）。因此 (b) 改用 vi.resetModules() + 动态 import 拿一份全新
// 的模块实例，顺序约束随之消失；本文件顶部静态 import 进来的那些符号仍指向原来的实例，其它
// 测试不受影响
describe('sendCurrentPetPresenceOnReady (Stage 3 part 2, FIX 2/FIX 3)', () => {
  it('(b) sends nothing when ready arrives before any evaluate has ever broadcast', async () => {
    // Models the real "no prior broadcast" case — the startup gate has not opened yet (see
    // startupGate.ts), so evaluatePetPresence's own early-return guard keeps
    // lastBroadcastPetPresence at null: the renderer mounting and reporting 'ready' before the
    // gate opens is a real, reachable sequence, not a testing artifact.
    //
    // 用一份全新的模块实例来断言这个原始状态，而不是依赖本 describe 在文件里的声明位置——
    // 见本 describe 上方注释。gate 也不需要在结尾恢复：这里关掉的是这份全新实例自己的
    // startupGate 模块状态，与其它测试使用的那份实例无关
    vi.resetModules()
    const fresh = await import('./windowBehavior')
    fresh.closeStartupGate()

    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })

    fresh.sendCurrentPetPresenceOnReady(win as unknown as Electron.BrowserWindow, null)

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

    sendCurrentPetPresenceOnReady(win as unknown as Electron.BrowserWindow, null)

    expect(win.webContents.send).toHaveBeenCalledWith('desktop-presence:changed', { presence: 'AMBIENT', edgeSide: null, handleSuppressed: false })
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

    // Same edge-collapsed x as the other EDGE tests in this file: -92 = 0 - (132 - 40).
    const win = makeFakeOverlayWindow({ x: -92, y: 0, width: 132, height: 132 })
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow) // enters EDGE, still collapsed
    vi.clearAllMocks()

    requestOverlayEdgeHover(win as unknown as Electron.BrowserWindow, null, true) // hover expands it
    win.getBounds = () => ({ x: 0, y: 0, width: 132, height: 132 }) // model the (mocked) move having happened
    vi.clearAllMocks()

    // The renderer reloads (dev HMR / a future crash-respawn) and remounts with no live hover
    // signal. Main still (wrongly, pre-fix) believes overlayEdgeHovered is true — 'ready' must
    // force it back to false and re-evaluate so the window collapses back to the edge, not stay
    // parked at the full bounds forever.
    sendCurrentPetPresenceOnReady(win as unknown as Electron.BrowserWindow, null)

    expect(animateTo).toHaveBeenCalledWith(win, { x: -92, y: 0, width: 132, height: 132 }, expect.any(Function))
  })
})

describe('handleWindowMoved (Fix A — explicit in-flight/quiet-until state, not a re-stamped timestamp)', () => {
  // Stage 3: this used to assert on noteUserDragActivity (electron/main/dragActivity.ts) being
  // skipped/called — that function no longer exists, since isWindowDragInProgress() is now driven
  // directly by WM_ENTERSIZEMOVE/WM_EXITSIZEMOVE (electron/main/windowDragMonitor.ts) rather than
  // by handleWindowMoved's own 'moved' handling. What handleWindowMoved's echo-recognition still
  // does, and what remains worth testing here, is whether it schedules a persist at all — a
  // recognized programmatic echo must short-circuit before the debounce timer is even set, so
  // persistBoundsNow (and its downstream commitHomeDisplayFromDragOutcome call) never runs.
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

// Fix 9 (this sweep, live bug, unrelated to the EDGE refactor — mandatory sanity check (iv)):
// persistBoundsNow was missing the same drag override handleWindowMoved already has —
// `if (isProgrammaticEchoFor(k) && !isWindowDragInProgress(k)) return`. handleWindowMoved
// deliberately lets a real drag through the echo guard and schedules the 300ms debounce;
// persistBoundsNow re-asked the same "is this an echo" question 300ms later WITHOUT the override
// and silently discarded the drop — exactly the regression the override exists to prevent, just
// moved later. Reachable today: markTopologySettle() opens a 1000ms quiet window (any display
// hot-plug / metrics change) and the debounce is only 300ms, so a drag that starts inside that
// quiet window has its drop lost and appliedDisplayId never updates.
describe('persistBoundsNow Fix 9 — a real drag landing inside a topology-settle quiet window must still persist (mandatory sanity check iv)', () => {
  it('does not drop a drop that arrives 300ms into a 1000ms topology-settle quiet window, because the window itself is still being dragged', () => {
    testState.displays = [makeDisplay(1, 0)]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => ({ id: 1 })

    // Any display-topology event (hot-plug / metrics change) opens a 1000ms quiet window on both
    // windows — see markTopologySettle's own definition.
    markTopologySettle()

    // A real drag is in progress the whole time — WM_ENTERSIZEMOVE fired before this quiet window
    // was even opened, and the user has not let go yet.
    testState.dragging = { overlay: true, chat: false }

    const win = makeFakeOverlayWindow({ x: 500, y: 0, width: 132, height: 132 })
    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, null)

    // 300ms later (the persist debounce), still well inside the 1000ms topology quiet window —
    // this is exactly the gap Fix 9 closes: without the drag override, isProgrammaticEchoFor alone
    // would classify this as an echo (quiet-until has not expired) and persistBoundsNow would
    // silently return, discarding the drop.
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

    expect(commitHomeDisplayFromDragOutcome).toHaveBeenCalledTimes(1)
  })
})

// FIX 3 (third rework pass): windowBehavior.test.ts's shared animateTo mock (top of this file)
// completes synchronously, so nothing in this suite previously exercised two overlapping real
// animations through this file's call sites, nor a real drag landing inside a live bracket — both
// defects were invisible to the suite by construction. These two tests use vi.mocked(animateTo)
// .mockImplementationOnce(...) to stand in for a real animateTo call that has NOT completed yet
// (captures its onComplete instead of invoking it), letting each test control exactly when — or
// whether — a given programmatic move "finishes", without needing real timers to drive
// windowAnimation.ts's own frame loop (already covered by windowAnimation.test.ts).
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
    // Settle at home first (no blocker) so appliedPetDisplayId starts at a known value (1),
    // independent of whatever an earlier describe block in this file left behind.
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    vi.clearAllMocks()

    // First relocate: home (1) blocked, only display 2 free -> moveToDisplay('overlay', 2). Left
    // deliberately incomplete — its onComplete is captured but never invoked, standing in for a
    // real animation that is still mid-flight (e.g. still fading out/in on the cross-display path,
    // or mid-tween on the same-display path) when the second relocate below preempts it.
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

    // Second relocate, before the first ever completes: display 2 now also blocked, only display 3
    // free -> moveToDisplay('overlay', 3). Real animateTo's existingCancel() would synchronously
    // run the FIRST call's onComplete as part of preempting it (see windowAnimation.ts's own
    // header comment on existingCancel()) — this mock reproduces exactly that ordering. This is
    // the crux of the bug: the preempted call's onComplete must not be allowed to release the
    // bracket the new (second) call just opened via beginProgrammaticMove — which, in the real
    // module, has already bumped the generation counter by the time this mock implementation runs
    // (moveToDisplay calls beginProgrammaticMove BEFORE calling animateTo).
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

    // Let any (buggy) quiet-tail that the preempted first onComplete might have wrongly started
    // expire BEFORE the 'moved' event arrives — with the fix, whether this tail exists at all is
    // irrelevant, because the in-flight flag itself (not a timer) is what still correctly reflects
    // the second, still-running animation. Without the fix, the first onComplete's unconditional
    // release would have cleared the in-flight flag and started only a
    // PROGRAMMATIC_ECHO_TAIL_MS-long tail anchored to this (the FIRST call's cancellation) instant
    // — well short of covering the genuinely still-running second animation.
    vi.advanceTimersByTime(PROGRAMMATIC_ECHO_TAIL_MS + 50)

    // The window's real on-screen position now matches where the second (still in-flight) relocate
    // is heading — display 3 — so that if this event is (wrongly) treated as a genuine drop, the
    // drag-outcome rules classify it as an ordinary in-refuge adjustment (row B2) and persist it,
    // giving this test a positive signal to fail on rather than merely "nothing happened".
    testState.matchDisplay = () => display3
    win.getBounds = () => ({ x: 3840, y: 0, width: 132, height: 132 })

    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, null)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

    expect(commitHomeDisplayFromDragOutcome).not.toHaveBeenCalled()

    // Cleanup: this test deliberately leaves the second (still-current) animation's bracket open
    // for its entire duration — close it out now so programmaticMoveInFlight does not leak 'overlay'
    // as permanently in-flight into later tests in this file (module state persists across tests,
    // same caveat this file's other describe blocks already document).
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
    // Settle at home first so there is a known appliedDisplayId to diff against below.
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    vi.clearAllMocks()

    // Home becomes blocked -> an automatic relocate to display 2 begins. The mock's returned
    // cancel function invokes the captured onComplete, matching the real animateTo contract
    // (calling the returned cancel function runs snap() -> onComplete) — this lets
    // cancelProgrammaticMoveOnDragStart below behave exactly as it would against the real module.
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

    // The user grabs the window mid-animation (WM_ENTERSIZEMOVE). FIX 2(a): the drag-start hook
    // (index.ts, mirrored here directly) cancels the in-flight relocate — this releases the
    // in-flight flag but immediately opens a PROGRAMMATIC_ECHO_TAIL_MS quiet tail (the same
    // onComplete path every other programmatic move uses, see beginProgrammaticMove).
    testState.dragging = { overlay: true, chat: false }
    cancelProgrammaticMoveOnDragStart('overlay')

    // The real drag produces a 'moved' event (including its drop) while still inside that short
    // quiet tail — no time has been advanced yet. FIX 2(b): handleWindowMoved must not suppress
    // this, because isWindowDragInProgress('overlay') is true; without that guard, the quiet tail
    // alone would misclassify this drop as an echo and never even schedule the persist debounce —
    // this is the scenario this test goes RED on if 2(b) is dropped (see the mandatory sanity
    // check for this rework pass, which reverts 2(a) and 2(b) together).
    testState.matchDisplay = () => display2
    win.getBounds = () => ({ x: 1920, y: 0, width: 132, height: 132 })

    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, null)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

    expect(commitHomeDisplayFromDragOutcome).toHaveBeenCalledTimes(1)
  })
})

describe('Fix C — a stale appliedDisplayId must not reach deriveDragContext after its display is unplugged', () => {
  it('treats the OS-forced repositioning after a refuge-display unplug as an at-home placement, not a phantom cross-display drag from a display that no longer exists', () => {
    // Home is display 1. It is blocked, so evaluatePetPresence auto-relocates the overlay to the
    // only free display, display 2 (appliedPetDisplayId becomes 2 — a real relocation, not a drag).
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

    // Advance past the post-relocate echo tail so the upcoming 'moved' is not itself mistaken
    // for the relocation's own echo — this test is about Fix C, not Fix A.
    vi.advanceTimersByTime(PROGRAMMATIC_ECHO_TAIL_MS + 10)

    // Display 2 (the refuge, holding the window) is unplugged. The blocker on display 1 has also
    // cleared (e.g. the game exited) — nothing here is a user drag. Windows repositions the
    // orphaned window itself, landing it on a THIRD display, 3, not home. There is no ordering
    // guarantee between Electron's display-removed dispatch and that OS-generated 'moved' — this
    // test models the 'moved' arriving without display-topology invalidation having run first,
    // which is exactly the race Fix C has to survive on its own (via appliedDisplayIdFor itself).
    const display3 = makeDisplay(3, 3840)
    testState.displays = [display1, display3]
    testState.blockerMap = new Map()
    testState.matchDisplay = () => display3
    win.getBounds = () => ({ x: 3840, y: 0, width: 132, height: 132 })

    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, null)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

    // With Fix C, appliedDisplayIdFor('overlay') notices display 2 is gone and returns null, so
    // deriveDragContext falls back to the (still-connected) home, display 1 — currentDisplayId
    // becomes 1, temporaryRelocation is false, and dropping on display 3 (≠ home) is handled by
    // the ordinary "at home, dropped on another free display" rule: home moves to 3. This is the
    // one and only outcome-changing consequence Fix C accepts (see the fix's own rationale) — the
    // alternative, unfixed behaviour never reaches this rule at all (see below), so this
    // assertion is what actually distinguishes fixed from reverted.
    expect(commitHomeDisplayFromDragOutcome).toHaveBeenCalledWith('overlay', {
      kind: 'accept',
      newPreferredDisplayId: 3,
      boundsWriteDisplayId: 3,
    })
  })
})

describe('Fix 1 (second rework pass) — per-window drag state, not one global flag', () => {
  // appliedPetDisplayId is windowBehavior.ts module state that survives across tests in this
  // file (see this file's own comment on programmaticMoveInFlight/programmaticQuietUntil for the
  // same caveat). Both tests below prime it to a known value (home, display 1) themselves —
  // an evaluate with no blocker and no drag always converges there — rather than assuming it
  // starts at null, so neither test depends on what earlier describe blocks left behind.
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

    // If the chat drag had wrongly driven the pet's isInteracting, resolvePetDesiredState would
    // report ACTIVE at the current (home) display and never relocate to the free display 2.
    expect(animateTo).toHaveBeenCalledWith(win, expect.objectContaining({ x: 1920, y: 0 }), expect.any(Function))
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

    // Under the exact same blocked-home/free-display-2 conditions as the previous test, the only
    // difference being which window is dragging: here the overlay itself is dragging, so it must
    // stay put (contrast with the chat-drag test above, which does relocate).
    expect(animateTo).not.toHaveBeenCalled()
  })

  it("each window's move-skip guard responds to its own drag only — chat still relocates while only the overlay is dragging", () => {
    const display1 = makeDisplay(1, 0)
    const display2 = makeDisplay(2, 1920)
    testState.displays = [display1, display2]
    testState.homeDisplayId = 1
    // appliedChatDisplayId is module state that survives across tests (same caveat as
    // appliedPetDisplayId above). No blocker + not dragging always converges it to home (1),
    // regardless of whatever an earlier test left it at — so this priming step doubles as both
    // "set chatPinMode" and "establish a known appliedChatDisplayId" before the real scenario below.
    testState.blockerMap = new Map()
    testState.dragging = { overlay: false, chat: false }

    const chatWin = makeFakeChatWindow({ x: 0, y: 0, width: 290, height: 520 })
    updateCachedWindowBehaviorConfig({ chatPinMode: 'smart', petAvoidanceEnabled: true, appRules: [] }, chatWin as unknown as Electron.BrowserWindow, null)
    vi.clearAllMocks() // discard the priming call's own animateTo/commitHomeDisplayFromDragOutcome calls

    // Now home gets blocked, display 2 is free, and only the overlay is (irrelevantly) dragging.
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    testState.dragging = { overlay: true, chat: false }

    evaluateDesktopPresence(chatWin as unknown as Electron.BrowserWindow, null)

    expect(animateTo).toHaveBeenCalledWith(chatWin, expect.objectContaining({ x: 1920, y: 0 }), expect.any(Function))
  })

  it("each window's move-skip guard responds to its own drag only — chat does NOT relocate while it itself is dragging", () => {
    const display1 = makeDisplay(1, 0)
    const display2 = makeDisplay(2, 1920)
    testState.displays = [display1, display2]
    testState.homeDisplayId = 1
    // appliedChatDisplayId is module state that survives across tests (same caveat as
    // appliedPetDisplayId above). No blocker + not dragging always converges it to home (1),
    // regardless of whatever an earlier test left it at — so this priming step doubles as both
    // "set chatPinMode" and "establish a known appliedChatDisplayId" before the real scenario below.
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
    // First evaluate: home (1) is blocked, only display 2 is free — relocates there,
    // appliedPetDisplayId becomes 2.
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    vi.clearAllMocks()

    // Display 2 (the one holding the overlay) is unplugged mid-interaction; only home (1) remains
    // connected. appliedDisplayIdFor('overlay') will notice 2 is gone and fall back to null, and
    // resolvePetDesiredState's ACTIVE branch falls back further to home (1) — which is not where
    // the window's own getBounds() below still claims it is, but that mismatch is exactly the
    // point (see Fix 6's comment at the guard in windowBehavior.ts).
    testState.displays = [display1]
    testState.dragging = { overlay: true, chat: false }

    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    expect(animateTo).not.toHaveBeenCalled()
  })
})

// Fix 1 (this cleanup pass, ts-backend-reviewer/integration-reviewer independently found two
// symptoms of the same line): runPetEdgeController's non-EDGE branch used to `return` on
// isInteracting BEFORE reaching settlePetPresence. Since isInteracting=true forces
// resolvePetDesiredState to report ACTIVE unconditionally (see the describe block above), that
// early return meant appliedPetPresence could structurally never become 'ACTIVE', and — worse —
// could get stuck at a stale 'EDGE' for as long as the user kept dragging, if an EDGE
// entry/exit animation was interrupted mid-flight by the drag starting.
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

    // Mandatory sanity check (i) target: reverting Fix 1 (restoring the `if (isInteracting)
    // return` before the settle calls) makes this go RED — settlePetPresence is never reached, so
    // appliedPetPresence never becomes 'ACTIVE' and this broadcast never fires; the only
    // desktop-presence:changed traffic left would be the (unchanged, hence suppressed) AMBIENT one
    // from the top-of-evaluate broadcast.
    testState.dragging = { overlay: true, chat: false }
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    expect(win.webContents.send).toHaveBeenCalledWith('desktop-presence:changed', {
      presence: 'ACTIVE',
      edgeSide: null,
      handleSuppressed: false,
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

    // Home softens to a SOFT blocker with nowhere else to go: EDGE. Capture (don't auto-run) the
    // EDGE-entry animation's onComplete — same mocking pattern as the Fix 2(a)/Fix 2(b) drag-start
    // test above — so it can be interrupted mid-flight instead of completing on its own.
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

    // The user grabs the window mid-collapse (WM_ENTERSIZEMOVE). The drag-start hook (index.ts,
    // mirrored here directly) cancels the in-flight animation, which runs its onComplete
    // synchronously: that settles appliedPetPresence to 'EDGE' first (the animation WAS entering
    // EDGE), then — reevaluate=true — re-evaluates with isInteracting now true.
    testState.dragging = { overlay: true, chat: false }
    cancelProgrammaticMoveOnDragStart('overlay')

    // Fix 1: that re-evaluate must settle applied all the way through to 'ACTIVE' in this same
    // synchronous chain, not stop at the 'EDGE' the interrupted animation had just settled — the
    // last broadcast on record must be ACTIVE/handleSuppressed:false. Mandatory sanity check (i):
    // reverting Fix 1 leaves this at EDGE/handleSuppressed:true instead, RED.
    expect(win.webContents.send).toHaveBeenLastCalledWith('desktop-presence:changed', {
      presence: 'ACTIVE',
      edgeSide: null,
      handleSuppressed: false,
    })
  })
})

describe('Presence broadcast (Stage 3 part 2, Task 1) — desktop-presence:changed only on change', () => {
  // lastBroadcastPetPresence (windowBehavior.ts) is module state that survives across tests in
  // this file (same caveat as appliedPetDisplayId/programmaticMoveInFlight noted elsewhere in
  // this file) — every test below first "settles" the overlay into a known presence and clears
  // mocks, then only asserts on the delta from there, rather than assuming this is the first
  // broadcast this process has ever made.
  it('does not broadcast again across repeated evaluates while the desired presence is unchanged', () => {
    testState.displays = [makeDisplay(1, 0)]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => ({ id: 1 })
    testState.blockerMap = new Map()
    testState.dragging = { overlay: false, chat: false }

    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    vi.clearAllMocks()

    // Mandatory sanity check (iii): if broadcastPetPresenceIfChanged's presencePayloadChanged
    // guard is removed (i.e. every evaluate sends unconditionally), this assertion goes RED —
    // it would see two calls, not zero, across these two repeated evaluates.
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  // Resolver/Controller 边界修正之后，这个转变现在产生两次广播而不是一次——安全门
  // （handleSuppressed）跟 latestDesired 走，必须在 desired 刚变成 EDGE 的这一刻（bounds 动画
  // 还没开始播）就先广播一次 fail-closed 信号；presence/edgeSide 本身仍然跟 applied 走，等
  // 收边动画真正落定才广播第二次。两次广播都由同一个 presencePayloadChanged 短路判断"变了没有"，
  // 不是无条件每次都发——这正是本用例名字里"then falls silent again"那一半要继续验证的
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

    // Home is the only display and is now soft-blocked with nowhere to relocate to: EDGE.
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['user-rule']), severity: 'soft' }],
    ])

    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    expect(win.webContents.send).toHaveBeenCalledTimes(2)
    // Mandatory sanity check (ii) target: front edge — handleSuppressed already true while
    // presence/edgeSide still describe the pre-transition (applied) state.
    expect(win.webContents.send).toHaveBeenNthCalledWith(1, 'desktop-presence:changed', {
      presence: 'AMBIENT',
      edgeSide: null,
      handleSuppressed: true,
    })
    // Once the collapse animation settles, presence/edgeSide catch up (applied), handleSuppressed
    // unchanged (still true — both desired and applied are EDGE now).
    expect(win.webContents.send).toHaveBeenNthCalledWith(2, 'desktop-presence:changed', {
      presence: 'EDGE',
      edgeSide: 'left',
      handleSuppressed: true,
    })

    // Re-evaluating under the exact same (still EDGE) conditions must not broadcast again.
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

    requestOverlayEdgeHover(win as unknown as Electron.BrowserWindow, null, true)

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

    // Starts already sitting at the edge-collapsed x (-92 = 0 - (132 - EDGE_VISIBLE_SLIVER_PX
    // 40)) — mirrors a window that a prior (unasserted) evaluate has already collapsed to the
    // edge, since this fake window's getBounds() is a static stand-in, not a real mutable
    // BrowserWindow that animateTo would have actually moved.
    const win = makeFakeOverlayWindow({ x: -92, y: 0, width: 132, height: 132 })
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow) // enters EDGE
    vi.clearAllMocks()

    // Mandatory sanity check (ii) is exercised at the pure-function level
    // (desktopPresence.test.ts's resolveEdgeHoverBounds tests) — this test instead pins the
    // orchestration wiring: hovered=true must actually reach animateTo with the full bounds.
    requestOverlayEdgeHover(win as unknown as Electron.BrowserWindow, null, true)
    expect(animateTo).toHaveBeenCalledTimes(1)
    expect(animateTo).toHaveBeenCalledWith(win, { x: 0, y: 0, width: 132, height: 132 }, expect.any(Function))

    // Simulate the (mocked, synchronous) animateTo call above having actually moved the window —
    // the shared animateTo mock in this file does not touch getBounds() itself (see its own
    // definition), so this test updates it manually to model what the real one would do.
    win.getBounds = () => ({ x: 0, y: 0, width: 132, height: 132 })
    vi.clearAllMocks()

    requestOverlayEdgeHover(win as unknown as Electron.BrowserWindow, null, false)
    expect(animateTo).toHaveBeenCalledTimes(1)
    expect(animateTo).toHaveBeenCalledWith(win, { x: -92, y: 0, width: 132, height: 132 }, expect.any(Function))
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

    requestOverlayEdgeHover(win as unknown as Electron.BrowserWindow, null, true)
    win.getBounds = () => ({ x: 0, y: 0, width: 132, height: 132 })
    vi.clearAllMocks()

    // A completely unrelated evaluate (e.g. the 1500ms blocker re-validation tick) runs while
    // still hovered/expanded and while the blocker is unchanged. It must not broadcast a presence
    // change (still EDGE) and must not move the window again (resolveEdgeHoverBounds must still
    // resolve to the same expanded target the window is already sitting at).
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

    // Priming step (appliedPetDisplayId/appliedPetPresence are module state that survives across
    // tests in this file, same caveat as elsewhere — see this file's own comments on that class of
    // state): settle at home/AMBIENT first with a window that starts at the eventual edge-collapsed
    // bounds already, so this test is deterministic regardless of what an earlier describe block
    // (e.g. requestOverlayEdgeHover's own EDGE tests) left appliedPetDisplayId/appliedPetPresence at.
    const win = makeFakeOverlayWindow({ x: -92, y: 0, width: 132, height: 132 })
    testState.blockerMap = new Map()
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    vi.clearAllMocks()

    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['user-rule']), severity: 'soft' }],
    ])
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow) // enters EDGE, still collapsed
    vi.clearAllMocks()

    // The blocker clears — home is free again, and desired.displayId stays home (unchanged), so
    // diffPetState's move stays null across this transition (see the bug analysis: this is exactly
    // why nothing else in the pipeline ever moves the window back). The episode ends (AMBIENT).
    testState.blockerMap = new Map()
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    expect(animateTo).toHaveBeenCalledTimes(1)
    expect(animateTo).toHaveBeenCalledWith(win, { x: 0, y: 0, width: 132, height: 132 }, expect.any(Function))
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

    requestOverlayEdgeHover(win as unknown as Electron.BrowserWindow, null, true) // expand
    expect(animateTo).toHaveBeenCalledWith(win, { x: 0, y: 0, width: 132, height: 132 }, expect.any(Function))
    win.getBounds = () => ({ x: 0, y: 0, width: 132, height: 132 })
    vi.clearAllMocks()

    testState.blockerMap = new Map() // episode ends while still hovered/expanded
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    // Already sitting exactly at the restored bounds — the boundsEqual idempotency short-circuit
    // must skip animateTo entirely, not play a redundant collapse-then-expand cycle.
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
    // Model the (mocked, synchronous) animateTo call above having actually moved the window, same
    // as the other EDGE tests in this file — the shared animateTo mock does not touch getBounds().
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

    // Mandatory sanity check target: with the exit-restore removed, this test's animateTo call
    // above never happens, but this assertion alone would still pass (no echo to misclassify) —
    // the collapsed-restore test above is the one that goes RED when the fix is reverted. This
    // test instead pins that, when the restore DOES happen, it goes through the same
    // programmatic-move bookkeeping as every other automatic move in this file (programmaticMoveInFlight
    // / markProgrammaticQuiet), so it can never be misread as a user drag and can never reach
    // persistBoundsNow / write preferredPosition or preferredDisplayId.
    win.getBounds = () => ({ x: 0, y: 0, width: 132, height: 132 })
    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, null)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

    expect(commitHomeDisplayFromDragOutcome).not.toHaveBeenCalled()
  })
})

// Mandatory sanity checks (i)/(ii)（docs/MintBot_TDD.md 同节"Resolver 不因为动画正在进行而
// 停止思考"+"安全门可以同时看 intent 与 fact"）：一次仍在飞的 relocate（跟这次新 desired 完全
// 无关）不得让 resolver 整个跳过——latestPetDesired 必须照常刷新，且 handleSuppressed 这条
// fail-closed 安全门必须在这一刻就广播出去，不等这次新 relocate 落定。
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

    // Home hard-blocked, display 2 free -> relocate there. Left deliberately incomplete (captured,
    // never invoked) — this is the "unrelated in-flight move" the resolver must not be blocked by.
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

    // The third evaluate below will decide a SECOND relocate is needed (back home, for EDGE) —
    // capture that one too, left incomplete as well, so it genuinely stays in flight through this
    // whole test (the mocked animateTo does not simulate the real module's existingCancel()
    // preemption of the first call, see 'moveToDisplay FIX 3' above for the same caveat spelled out).
    let capturedSecondRelocateOnComplete: (() => void) | undefined
    vi.mocked(animateTo).mockImplementationOnce((_win, _target, onComplete) => {
      capturedSecondRelocateOnComplete = onComplete
      return () => {}
    })
    vi.clearAllMocks()

    // While that relocate is still in flight, display 2 (the refuge) also becomes hard-blocked and
    // home softens instead of clearing -> nowhere is free -> desired becomes EDGE at home. This is
    // exactly the geometry-rule scenario above (a relocate back home is needed before EDGE bounds
    // can be computed) — the point of THIS test is the safety-gate side effect, not the bounds
    // side effect: handleSuppressed must flip to true in THIS same evaluate call, synchronously,
    // before the relocate-to-home has even been decided, let alone settled.
    //
    // Mandatory sanity check (i) target: if evaluatePetPresence were changed to return early
    // whenever programmaticMoveInFlight.has('overlay') is true (the pre-refactor behaviour this
    // whole section replaces), latestPetDesired would never be updated here and this assertion
    // goes RED (no send call at all).
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['user-rule']), severity: 'soft' }],
      [2, { hwnd: 2n, pid: 2, exeName: null, displayId: 2, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    expect(win.webContents.send).toHaveBeenCalledWith(
      'desktop-presence:changed',
      expect.objectContaining({ handleSuppressed: true })
    )

    // Mandatory sanity check (ii) target: if computeHandleSuppressed were changed to read only
    // `applied` (dropping the latestDesired half), the assertion above goes RED too — applied is
    // still 'AMBIENT' at this point (the relocate to home has not even started animating, let
    // alone settled), so only the latestDesired half can be responsible for this being true.

    // Cleanup (same convention as the other tests in this file that deliberately leave a bracket
    // open): the stale first relocate's completion is a superseded-generation no-op; the second
    // one is the current in-flight bracket and must be released so it does not leak 'overlay' as
    // permanently in-flight into later tests.
    capturedRelocateOnComplete?.()
    capturedSecondRelocateOnComplete?.()
  })
})

// Geometry rule (docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"Resolver / Controller 边界：
// 执行锁不是决策锁（阶段④ 修正）"一节，原文："依赖最终窗口几何的后续 transition，不在前一个
// programmatic move settle 前执行"): a relocate (moveToDisplay) and an EDGE-entry computation
// (runPetEdgeController) can both be decided by the same evaluate — refuge on display 2, home (1)
// softens to a blocker with nowhere free, so the resolver sends the pet back home in EDGE form.
//
// Under the pre-refactor design this was a dedicated patch ("PREREQ 1") bolted onto
// applyEdgePlacement, checked via its own programmaticMoveInFlight read. Under the Resolver/
// Controller model this is no longer a special case: evaluatePetPresence's Controller half
// returns immediately after starting a relocate (transition.move !== null) without ever calling
// runPetEdgeController in that same tick — EDGE bounds are only ever computed once displayId has
// already settled, by construction, not by an extra check bolted onto the EDGE branch itself. This
// test is kept, rewritten against that structure, because the regression it pins (reading stale —
// and, worse, wrong-display — geometry) is real and worth continuing to guard.
describe('geometry rule — EDGE bounds computation is deferred past an in-flight relocate instead of reading stale getBounds()', () => {
  it('does not compute EDGE bounds until the relocate that lands the window back home has actually completed', () => {
    const display1 = makeDisplay(1, 0) // home: y=0
    const display2 = { id: 2, bounds: { x: 1920, y: 300, width: 1920, height: 800 }, workArea: { x: 1920, y: 300, width: 1920, height: 800 }, scaleFactor: 1 } // deliberately different vertical geometry
    testState.displays = [display1, display2]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => display1
    testState.dragging = { overlay: false, chat: false }

    // Step 1: home hard-blocked, display 2 free -> refuge relocate to display 2.
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    win.getBounds = () => ({ x: 1920, y: 300, width: 132, height: 132 }) // model the relocate having landed on display 2
    vi.clearAllMocks()

    // Step 2: home softens to a SOFT blocker, display 2 now ALSO blocked -> nowhere free -> EDGE
    // at home. The pet is currently on display 2, so this requires a relocate back home.
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

    // Only the relocate's own animateTo call has happened so far — the fix must NOT have also
    // synchronously computed and applied an EDGE target off display 2's stale (and differently
    // positioned) bounds in this same tick.
    expect(animateTo).toHaveBeenCalledTimes(1)
    expect(capturedRelocateOnComplete).toBeDefined()

    // Fix 1 (fourth rework pass, mandatory sanity-check target): a third, independently-triggered
    // evaluate — modelling the 500ms foreground poll or the 1500ms blocker-validation loop landing
    // mid-flight — must not treat "this call didn't itself trigger a move" as "nothing is moving".
    // Before the fix this read relocatedThisEvaluate, a per-call local that is false here (this
    // call's own diff sees the target already applied), and went on to read win.getBounds() —
    // still display 2's stale, differently-positioned geometry — computing and applying a second,
    // wrong EDGE target that would supersede the original relocate via the generation counter.
    vi.clearAllMocks()
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    expect(animateTo).not.toHaveBeenCalled()
    expect(win.webContents.send).not.toHaveBeenCalled()

    // The relocate settles: the window is now actually on display 1 (home).
    win.getBounds = () => ({ x: 0, y: 0, width: 132, height: 132 })
    capturedRelocateOnComplete?.()

    // Only now must the EDGE computation run — using display 1's geometry (y=0), not display 2's
    // stale y=300. -92 = 0 - (132 - EDGE_VISIBLE_SLIVER_PX 40), matching every other EDGE test here.
    expect(animateTo).toHaveBeenCalledTimes(1)
    expect(animateTo).toHaveBeenLastCalledWith(win, { x: -92, y: 0, width: 132, height: 132 }, expect.any(Function))
  })
})

// Broadcast-follows-applied (docs/MintBot_TDD.md 同节"广播跟 applied，不跟 desired"一节):
// broadcastPetPresenceIfChanged used to fire synchronously the instant applyEdgePlacement
// scheduled the EDGE-exit restore animateTo, not when that animation actually finished — the
// renderer un-suppresses the drag handle off that broadcast, so it would do so while the window
// was still mid same-display tween.
//
// Under the pre-refactor design this was a dedicated patch ("PREREQ 2") — a boolean returned by
// applyEdgePlacement telling the caller "don't broadcast yet, I've deferred it". Under the
// Resolver/Controller model this is no longer a special case: presence/edgeSide in the broadcast
// payload are only ever written by settlePetPresence, which only runs once a transition has
// actually settled — entry and exit are now symmetric by construction, not by two separately
// maintained defer flags. This test is kept, rewritten against that structure, because the
// regression it pins (the renderer un-suppressing the handle mid-animation) is real.
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

    // Blocker clears -> episode ends -> AMBIENT, with a genuine (not yet complete) restore animation.
    testState.blockerMap = new Map()
    let capturedRestoreOnComplete: (() => void) | undefined
    vi.mocked(animateTo).mockImplementationOnce((_win, _target, onComplete) => {
      capturedRestoreOnComplete = onComplete
      return () => {}
    })

    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    // The restore animation has been scheduled but has not completed — the handle-relevant
    // presence broadcast must not have gone out yet (the renderer would otherwise un-suppress the
    // drag handle while the window is still mid-tween back to its full bounds).
    expect(animateTo).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).not.toHaveBeenCalled()

    // Fix 1 (fourth rework pass, mandatory sanity-check target): a third, independently-triggered
    // evaluate landing while the restore above is still in flight. Before the fix, wasEdgeLastEvaluate
    // — a one-shot flag — was already cleared to false by the call above (unconditionally, before the
    // restore was even queued), so this call's own `episodeWasActive` reads false and it falls straight
    // through to an immediate broadcast, even though the window is still mid-tween. It must not queue
    // a second restore animateTo either.
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    expect(animateTo).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).not.toHaveBeenCalled()

    // The restore animation completes.
    win.getBounds = () => ({ x: 0, y: 0, width: 132, height: 132 })
    capturedRestoreOnComplete?.()

    expect(win.webContents.send).toHaveBeenCalledWith('desktop-presence:changed', { presence: 'AMBIENT', edgeSide: null, handleSuppressed: false })
  })
})

// Broadcast-follows-applied, relocate path: EDGE exit coinciding with a relocate to a different,
// newly-free display is the same "live-but-invisible/mid-transition window" as the restore-tween
// case above, just reached via moveToDisplay instead of runPetEdgeController's own animation.
// Under the Resolver/Controller model both paths converge on the same mechanism — moveToDisplay's
// onSettled re-runs evaluatePetPresence, which only broadcasts once appliedPetPresence has
// actually been written by settlePetPresence — there is no second, relocate-specific defer flag.
describe('broadcast follows applied, relocate path — the EDGE-exit-via-relocate presence broadcast is deferred until the relocate settles', () => {
  it('does not broadcast AMBIENT until the cross-display relocate animation actually completes', () => {
    const display1 = makeDisplay(1, 0)
    const display2 = makeDisplay(2, 1920)
    testState.displays = [display1, display2]
    testState.homeDisplayId = 1
    testState.matchDisplay = () => display1
    testState.dragging = { overlay: false, chat: false }

    // Step 1: home has a soft blocker, display 2 is ALSO blocked -> nowhere free -> EDGE at home.
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['user-rule']), severity: 'soft' }],
      [2, { hwnd: 2n, pid: 2, exeName: null, displayId: 2, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    const win = makeFakeOverlayWindow({ x: -92, y: 0, width: 132, height: 132 })
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow) // enters EDGE at home
    vi.clearAllMocks()

    // Step 2: display 2 frees up -> nowhere is blocked anymore -> relocate there, presence AMBIENT.
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['user-rule']), severity: 'soft' }],
    ])
    let capturedRelocateOnComplete: (() => void) | undefined
    vi.mocked(animateTo).mockImplementationOnce((_win, _target, onComplete) => {
      capturedRelocateOnComplete = onComplete
      return () => {}
    })

    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    // The relocate has only STARTED — moveToDisplay merely begins a (mocked, up to real 500ms)
    // cross-display animation. The presence broadcast must not fire in this same tick.
    expect(animateTo).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).not.toHaveBeenCalled()

    // A further evaluate landing while that relocate is still in flight must not queue a second
    // one, nor broadcast early either.
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    expect(animateTo).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).not.toHaveBeenCalled()

    // The relocate settles.
    win.getBounds = () => ({ x: 1920, y: 0, width: 132, height: 132 })
    capturedRelocateOnComplete?.()

    expect(win.webContents.send).toHaveBeenCalledWith('desktop-presence:changed', { presence: 'AMBIENT', edgeSide: null, handleSuppressed: false })
  })
})

// Mandatory sanity check (iii)（docs/MintBot_TDD.md 同节"绝不要做 move queue"）："桌宠只需要追
// 最后状态。移动 A -> B 期间 desired 依次变成 C、A、C，settle 时只看 latest desired = C，中间
// target 全部丢弃——而不是排成 B -> C -> A -> C 依次执行。" 本用例逐字对应这个例子：目标依次是
// B、C、A、C，四次都在前一次仍未落定时就被新的 desired 抢占（沿用既有的世代号机制），最后只
// 结算一次、落在 C——不是依次真正执行完 B/A 各自的动画。
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

    // Target 1: B. Home blocked, B free.
    captureNextAnimateTo()
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    expect(animateTo).toHaveBeenLastCalledWith(win, expect.objectContaining({ x: displayB.bounds.x }), expect.any(Function))

    // Target 2: C. B also blocked now — while the B-relocate above is still in flight (never
    // invoked), a new evaluate decides C instead.
    captureNextAnimateTo()
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
      [2, { hwnd: 2n, pid: 2, exeName: null, displayId: 2, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    expect(animateTo).toHaveBeenLastCalledWith(win, expect.objectContaining({ x: displayC.bounds.x }), expect.any(Function))

    // Target 3: A (home) — home frees up while C is also now blocked.
    captureNextAnimateTo()
    testState.blockerMap = new Map([
      [2, { hwnd: 2n, pid: 2, exeName: null, displayId: 2, reasons: new Set(['fullscreen']), severity: 'hard' }],
      [3, { hwnd: 3n, pid: 3, exeName: null, displayId: 3, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    expect(animateTo).toHaveBeenLastCalledWith(win, expect.objectContaining({ x: displayHome.bounds.x }), expect.any(Function))

    // Target 4: C again — home re-blocks, B stays blocked, C frees up. This is the FINAL desired.
    captureNextAnimateTo()
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
      [2, { hwnd: 2n, pid: 2, exeName: null, displayId: 2, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    expect(animateTo).toHaveBeenLastCalledWith(win, expect.objectContaining({ x: displayC.bounds.x }), expect.any(Function))

    expect(captured).toHaveLength(4)
    vi.clearAllMocks()

    // Settling the three superseded targets (B, C-the-first-time, A), in order, must be a pure
    // no-op each time — no further animateTo call, because none of them is the current generation.
    captured[0]() // B
    captured[1]() // C (first time)
    captured[2]() // A
    expect(animateTo).not.toHaveBeenCalled()

    // Settling the FINAL (current-generation) target, C, is what actually lands: the window must
    // now genuinely be on display C, not on B or A — proven by a follow-up evaluate under the same
    // (target-4) blocker map finding nothing left to do.
    captured[3]()
    win.getBounds = () => ({ x: displayC.bounds.x, y: 0, width: 132, height: 132 })
    vi.clearAllMocks()
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    expect(animateTo).not.toHaveBeenCalled()
  })

  // The relocate-chasing test above is not sensitive to reverting settlePetPresence's own
  // reconciliation step (appliedPetDisplayId is written eagerly, before the animation even starts
  // — see moveToDisplay's call site — so a stale settle finds displayId already "converged"
  // regardless of whether it re-checks latestPetDesired). appliedPetPresence/appliedPetEdgeSide are
  // different: they are ONLY written by settlePetPresence, at settle time, so a settle that
  // applies what it captured at animation-START (an intermediate desired) and never re-checks
  // latestPetDesired-at-settle-time leaves a real, observable inconsistency. This test targets
  // exactly that mechanism, using presence (EDGE -> HIDDEN) instead of displayId as the dimension
  // that changes mid-flight.
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

    // Home softens to a SOFT blocker with nowhere to relocate to (single display): EDGE. The
    // window is not yet at the edge-collapsed bounds, so this starts a genuine tween — captured,
    // not invoked, to model it still being in flight.
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

    // While that entry animation is still in flight, home escalates to a HARD blocker instead —
    // desired becomes HIDDEN. programmaticMoveInFlight is still true (the entry animation hasn't
    // settled), so this evaluate only applies visibility (hide()) and stores the new
    // latestPetDesired; it cannot touch EDGE bounds yet (geometry rule).
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    vi.clearAllMocks()

    // The entry animation now settles. Mandatory sanity check (iii) target: settlePetPresence must
    // not just apply EDGE (what this animation was FOR, decided before desired changed) and stop —
    // it must go on to notice latestPetDesired is now HIDDEN and reconcile. If it stops at EDGE
    // (the injected bug — no reconciliation after settling), the broadcast below never happens,
    // and the LAST broadcast on record stays presence: 'EDGE' forever, even though the pet should
    // by now be HIDDEN.
    capturedEntryOnComplete?.()

    expect(win.webContents.send).toHaveBeenLastCalledWith(
      'desktop-presence:changed',
      expect.objectContaining({ presence: 'HIDDEN' })
    )
  })
})

// Fix 3 (fourth rework pass, ts-backend-reviewer): moveToDisplay used to write
// `activeAnimationCancelFor.set(windowKey, cancel)` unconditionally, AFTER animateTo(...) returns.
// This test forces the (structurally possible, not reachable via any real animateTo today) scenario
// where a nested, still-current-generation programmatic move registers ITS OWN cancel function
// before the outer call gets a chance to write its own — by making the outer animateTo mock mutate
// the blocker map and synchronously complete before returning, which (now that Fix 2 always wires
// onSettled) triggers a nested evaluate that itself relocates again.
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

    // Priming step: appliedPetDisplayId is module-level state that leaks across this file's other
    // tests (see this file's header comment on that class of shared state). Force it to a known
    // value (home) before the real steps below, so this test's own relocate is deterministic
    // regardless of whatever an earlier test left behind.
    testState.blockerMap = new Map()
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    vi.clearAllMocks()

    // Home hard-blocked, display 3 also hard-blocked, display 2 free -> relocate to display 2.
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
      [3, { hwnd: 3n, pid: 3, exeName: null, displayId: 3, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])

    const cancelOuter = vi.fn()
    const cancelNested = vi.fn()

    vi.mocked(animateTo)
      .mockImplementationOnce((_win, _target, onComplete) => {
        // World changes before this (outer) animation "completes": display 2 — the display we are
        // relocating to — becomes blocked too, while display 3 frees up. Calling onComplete here
        // (synchronously, before this mock returns) drives moveToDisplay's onSettled -> a nested
        // evaluatePetPresence -> a second relocate (display 2 -> display 3), which bumps the
        // generation for 'overlay' and registers its own cancel function before this outer call's
        // own moveToDisplay gets to write anything.
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

    // Fix 3: the nested (current-generation) cancel function must be the one a real drag-start
    // ends up invoking — not the outer, now-stale one whose own write must have been skipped.
    cancelProgrammaticMoveOnDragStart('overlay')
    expect(cancelNested).toHaveBeenCalledTimes(1)
    expect(cancelOuter).not.toHaveBeenCalled()
  })
})

// drag-end 主动收敛（计划 §20）。这里测的是"落点定下来之后，桌面状态立刻被重新求值"这条
// 编排义务——纯函数层没有任何东西能触及它：resolver 是无状态的，而这条链路的全部内容就是
// persistBoundsNow 的三条终点各自在什么时机、以什么顺序调用了哪三个副作用。
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

    // 一次收敛 = 一次 blocker 复查 + 一次重新求值。求值本身的可观测证据是拖拽尾巴已经被收掉：
    // endDragTail 之后 isWindowDragInProgress 为假，resolver 才可能求出非 ACTIVE 的 desired
    expect(revalidateBlockersNowMock).toHaveBeenCalledTimes(1)
    expect(testState.dragging.overlay).toBe(false)
  })

  it('顺序固定：blocker 复查发生在拖拽尾巴被收掉之前', () => {
    const { display2 } = twoDisplays()
    testState.blockerMap = new Map()
    testState.matchDisplay = () => display2
    testState.dragging = { overlay: true, chat: false }

    // 复查跑的那一刻，尾巴必须仍然开着——selectValidationMode 靠它选中 conservative，
    // 不能退化成只依赖 isSelfForeground
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

    // 先让 home(1) 被挡，把窗口自动避难到 2——这一步同时建立 lastValidPlacement
    testState.blockerMap = new Map([
      [1, { hwnd: 1n, pid: 1, exeName: null, displayId: 1, reasons: new Set(['fullscreen']), severity: 'hard' }],
    ])
    testState.matchDisplay = () => display2
    const win = makeFakeOverlayWindow({ x: 1920, y: 0, width: 132, height: 132 })
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
    vi.advanceTimersByTime(PROGRAMMATIC_ECHO_TAIL_MS + 10)
    vi.clearAllMocks()

    // 用户把它拖回仍然被挡的 home(1)：resolveDragOutcome 判定 reject
    testState.dragging = { overlay: true, chat: false }
    testState.matchDisplay = () => display1
    win.getBounds = () => ({ x: 0, y: 0, width: 132, height: 132 })

    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, win as unknown as Electron.BrowserWindow)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

    expect(commitHomeDisplayFromDragOutcome).not.toHaveBeenCalled()
    expect(revalidateBlockersNowMock).toHaveBeenCalledTimes(1)
    expect(testState.dragging.overlay).toBe(false)
  })

  it('一次 drag-end 只触发一次主动收敛', () => {
    const { display2 } = twoDisplays()
    testState.blockerMap = new Map()
    testState.matchDisplay = () => display2
    testState.dragging = { overlay: true, chat: false }

    const win = makeFakeOverlayWindow({ x: 1920, y: 0, width: 132, height: 132 })
    win.getBounds = () => ({ x: 1920, y: 0, width: 132, height: 132 })

    // 一次拖拽里逐帧到达的多个 'moved'：落盘防抖把它们合并成一次 persistBoundsNow
    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, win as unknown as Electron.BrowserWindow)
    vi.advanceTimersByTime(50)
    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, win as unknown as Electron.BrowserWindow)
    vi.advanceTimersByTime(50)
    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, win as unknown as Electron.BrowserWindow)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

    expect(revalidateBlockersNowMock).toHaveBeenCalledTimes(1)
  })
})

// 关闭 petAvoidanceEnabled 后退出托管状态（计划 §26），Controller 层。
//
// Resolver 是无状态的——"从 HIDDEN 来""从 EDGE 来""从 RELOCATED 来"在它眼里是同一个输入，
// 所以这三行在纯函数层会塌缩成一条，测不出区别。这里测的是编排层：从三种不同的 applied 出发，
// 关掉开关之后，物理副作用与最终 applied 是否都收敛到 AMBIENT @ home。
describe('关闭 petAvoidanceEnabled 后退出托管状态（Controller 层）', () => {
  const AVOIDANCE_ON = { chatPinMode: 'off' as const, petAvoidanceEnabled: true, appRules: [] }
  const AVOIDANCE_OFF = { chatPinMode: 'off' as const, petAvoidanceEnabled: false, appRules: [] }
  const HOME_BOUNDS = { x: 0, y: 0, width: 132, height: 132 }

  // 本文件共用的 makeFakeOverlayWindow 的 isVisible 恒为 false，测不出 HIDDEN → 可见这条迁移，
  // 这里换一个 show/hide 会真的翻转可见性的版本
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
      // HIDDEN 时 desired.alwaysOnTop 为 false，退出托管必须把它重新设回 true
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
      // 托管态仍是 AMBIENT，与上一次广播相同、被幂等短路，没有帧可读——改用落点断言：
      // 它必须已经避难到第二块屏
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

      // 先建立托管状态
      updateCachedWindowBehaviorConfig(AVOIDANCE_ON, null, win as unknown as Electron.BrowserWindow)
      if (row.managedPresence !== null) {
        expect(lastPresencePayload(win)?.presence).toBe(row.managedPresence)
      }
      if (row.managedDisplayX !== null) {
        expect(win.getBounds().x).toBe(row.managedDisplayX)
      }

      // 退出托管
      vi.clearAllMocks()
      updateCachedWindowBehaviorConfig(AVOIDANCE_OFF, null, win as unknown as Electron.BrowserWindow)

      // 物理副作用
      expect(win.isVisible()).toBe(true)
      if (row.expectsAlwaysOnTopRestored) {
        expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, expect.anything())
      }
      if (row.expectsHomeBounds) {
        // EDGE 收窄过 x、RELOCATED 停在别的屏——两者都必须回到 home 这块屏的完整 bounds。
        // animateTo 的 mock 会把 getBounds 指向它收到的目标，因此这里读到的就是最终落点
        expect(win.getBounds()).toEqual(HOME_BOUNDS)
      }

      // 最终 applied：贴边手柄抑制解除，presence 收敛到 AMBIENT
      win.webContents.send.mockClear()
      sendCurrentPetPresenceOnReady(win as unknown as Electron.BrowserWindow, null)
      expect(lastPresencePayload(win)).toEqual({ presence: 'AMBIENT', edgeSide: null, handleSuppressed: false })

      // 不留欠债：再求一次值不产生任何新的物理动作
      vi.clearAllMocks()
      evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)
      expect(animateTo).not.toHaveBeenCalled()
      expect(win.showInactive).not.toHaveBeenCalled()
      expect(win.hide).not.toHaveBeenCalled()
    })
  }
})

// 非法 drop 的回滚接线（计划 §41）。纯函数层已经证明 resolveDragOutcome 会返回 reject；
// 这里测的是"reject 之后编排层真的把窗口弹了回去"。
describe('非法 drop 的回滚接线', () => {
  function blocker(displayId: number) {
    return { hwnd: 1n, pid: 1, exeName: null, displayId, reasons: new Set(['fullscreen']), severity: 'hard' }
  }

  type Rect = { x: number; y: number; width: number; height: number }

  // 目标矩形是否与当前仍连着的某块显示器的 workArea 有有效交集——即它归属于当前 topology。
  // 比断言"x 不等于某个具体数字"稳：后者只排除一个已知的坏值，前者描述的是真正要保证的性质
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

  // home(1) 被挡 → 自动避难到 2。这一步同时把 lastValidTemporaryPlacement 记成 2，
  // 是下面两个场景共同的前置状态
  function relocateToDisplayTwo(displays: ReturnType<typeof makeDisplay>[]) {
    // appliedPetDisplayId 是跨测试存活的模块状态，先无冲突地收敛到 home，
    // 让这个前置状态与之前跑过哪些用例无关
    openStartupGate()
    testState.displays = displays
    testState.homeDisplayId = 1
    testState.blockerMap = new Map()
    testState.matchDisplay = () => displays[0]

    const win = makeFakeOverlayWindow({ x: 0, y: 0, width: 132, height: 132 })
    // cachedConfig 同样跨测试存活——显式把避让打开，否则 resolver 恒定返回 AMBIENT@home，
    // 根本不会产生避难
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

    // 用户把它拖到 3，而 3 此刻也被挡住
    testState.blockerMap = new Map([[1, blocker(1)], [3, blocker(3)]])
    testState.dragging = { overlay: true, chat: false }
    testState.matchDisplay = () => displays[2]
    win.getBounds = () => ({ x: 3840, y: 0, width: 132, height: 132 })

    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, win as unknown as Electron.BrowserWindow)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

    // 物理上弹回避难屏 2 的落点，而不是停在被拒绝的 3
    expect(win.getBounds()).toEqual({ x: 1920, y: 0, width: 132, height: 132 })
    // 被拒绝的这次拖拽不写任何偏好
    expect(setPreferredBoundsMock).not.toHaveBeenCalledWith('overlay', 3, expect.anything())
    expect(commitHomeDisplayFromDragOutcome).not.toHaveBeenCalled()
  })

  it('回滚仍在进行时到达的新意图不会丢失，settle 之后被消费', () => {
    const displays = [makeDisplay(1, 0), makeDisplay(2, 1920), makeDisplay(3, 3840)]
    const win = relocateToDisplayTwo(displays)
    vi.clearAllMocks()

    // 让这次回滚停在半空中：捕获 onComplete，不立即调用
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

    // 回滚还没落定，世界变了：home 的冲突解除，最新意图变成"回家"
    testState.blockerMap = new Map()
    evaluateDesktopPresence(null, win as unknown as Electron.BrowserWindow)

    // 用户此刻还捏着窗口（尾巴未收），所以这次求值不该移动它
    expect(win.getBounds()).toEqual({ x: 3840, y: 0, width: 132, height: 132 })

    // 回滚落定 → reconcile 收掉尾巴并重新求值 → 消费最新意图，回到 home
    finishRollback!()

    expect(win.getBounds()).toEqual({ x: 0, y: 0, width: 132, height: 132 })
  })
  // 临时屏断开：applied placement 随之失效并重新定基。
  //
  // appliedDisplayIdFor 会先把已失联的 appliedDisplayId 清掉，deriveDragContext 因此读成"在家"，
  // temporaryRelocation 为 false——系统不会尝试回到那块已经断开的 placement，这次 drop 按
  // "在家拖拽"规则处理。
  it('rebases drag ownership after the temporary display disconnects', () => {
    const displays = [makeDisplay(1, 0), makeDisplay(2, 1920), makeDisplay(3, 3840)]
    const win = relocateToDisplayTwo(displays)
    vi.clearAllMocks()

    // 承载窗口、同时也是 lastValidTemporaryPlacement 记录的那块屏被拔掉
    const connected = [displays[0], displays[2]]
    testState.displays = connected
    testState.blockerMap = new Map([[1, blocker(1)], [3, blocker(3)]])
    testState.dragging = { overlay: true, chat: false }
    testState.matchDisplay = () => displays[2]
    win.getBounds = () => ({ x: 3840, y: 0, width: 132, height: 132 })

    handleWindowMoved('overlay', win as unknown as Electron.BrowserWindow, null, win as unknown as Electron.BrowserWindow)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 10)

    // 每一个程序化移动的目标都必须落在当前仍连着的某块显示器的 workArea 内
    for (const [, target] of vi.mocked(animateTo).mock.calls) {
      expect(intersectsConnectedWorkArea(target as Rect, connected)).toBe(true)
    }
    // 最终落点同样归属于当前 topology 里的一块显示器
    expect(intersectsConnectedWorkArea(win.getBounds(), connected)).toBe(true)
    // 不为已断开的显示器写入任何偏好
    expect(setPreferredBoundsMock).not.toHaveBeenCalledWith('overlay', 2, expect.anything())
    // 辅助断言：不会被送回那块屏的坐标
    expect(win.getBounds().x).not.toBe(1920)
  })

  // 窄不变量：lastValidTemporaryPlacement 必须始终跟随当前 applied placement。
  //
  // 这是 persistBoundsNow 敢于无条件信任回滚目标的前提——两者一旦分叉，非法 drop 就可能被弹到
  // 一个窗口早已不在、甚至已经断开的地方。用行为验证而不是读内部状态：先用不同路径把窗口放到
  // 一个临时落点，再制造一次非法 drop，窗口必须正好回到它此刻所在的地方。
  describe('lastValidTemporaryPlacement 始终跟随 applied placement', () => {
    const PATHS = [
      {
        name: '自动避难落点',
        expectedX: 1920,
        // 只挡住 drop 目标，保留当前落点空闲——否则回滚之后的收敛会因为"无处可去"
        // 把窗口又挪走，测到的就不是回滚本身了
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
          // 2 也挡住，让 3 成为唯一空闲屏——否则落定后的收敛会把窗口挪回 id 最小的空闲屏 2
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

        // 回滚目标正是窗口此刻所在的 applied placement
        expect(win.getBounds().x).toBe(path.expectedX)
      })
    }
  })
})
