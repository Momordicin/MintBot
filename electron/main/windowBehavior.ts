import { BrowserWindow, screen } from 'electron'
import { animateTo } from './windowAnimation'
import {
  getPreferredBounds,
  setPreferredBounds,
  getEffectiveHomeDisplay,
  computeDefaultBoundsForDisplay,
  clampBoundsToWorkArea,
  DEFAULT_WINDOW_SIZE,
  PERSIST_DEBOUNCE_MS,
} from './windowPositions'
import type { WindowKey } from './windowPositions'
import { commitHomeDisplayFromDragOutcome } from './homeDisplayCommit'
import { getDisplayStateMap, revalidateBlockersNow } from './foregroundWorldModel'
import type { AppRule } from './displayStateMap'
import {
  resolvePetDesiredState,
  resolveChatDesiredState,
  diffPetState,
  diffChatState,
  resolveDragOutcome,
  deriveDragContext,
  isTemporaryPlacement,
  isProgrammaticMoveEcho,
  extendQuietUntil,
  resolveEdgeSide,
  resolveStableEdgeSide,
  computeEdgeBounds,
  EDGE_VISIBLE_SLIVER_PX,
  resolveEdgeHoverBounds,
  presencePayloadChanged,
  computeHandleSuppressed,
} from './desktopPresence'
import type { EdgeSide, DesiredPetState, PetPresence, PetPresencePayload } from './desktopPresence'
import { isWindowDragInProgress, endDragTail } from './dragActivity'

// 悬浮窗行为策略的实际置顶/躲避逻辑（buzzing-frolicking-eich.md 计划子任务③，依赖子任务①
// 的配置层/托盘骨架 + 子任务②的 activeWindowMonitor 扩展，均已合入）。从 index.ts 独立成
// 文件，理由跟 activeWindowMonitor.ts 独立成文件一样：这块逻辑体量不小，index.ts 已经 340+ 行
//
// Stage 2（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机（Desktop Presence，四阶段重设计）」
// 阶段②）：本文件曾经的 episode 欠债模型——decideDodge/decideDodgeClear/
// shouldSkipOverlayDodge/handleOverlayDodge/handlePinMode/handleActiveWindowChange，以及
// dodgeDisplayId/overlayDodgeSourceDisplayId/isDodgeParked/endDodgeEpisodeIfLeavingDodgeMode
// 这一整套跟踪状态——已整体删除，替换为 evaluatePetPresence/evaluateChatPresence：读
// electron/main/foregroundWorldModel.ts 的 getDisplayStateMap() + electron/main/
// desktopPresence.ts 的纯 resolver/diff 函数，每次调用都从当前 Desktop Context 重新求一次
// desired 状态，不再维护"欠一次 show()/setAlwaysOnTop() 的账"。旧函数里几段仍然成立的
// Windows 平台知识（applyAlwaysOnTop 为什么必须幂等、PIN_LEVEL = 'screen-saver' 的 z-order
// 分析）原样保留在下面，没有随旧逻辑一起删除。

// 主进程本地类型：跟 index.ts 里 CORE_URL/ChatPinMode/WindowBehaviorConfig 同样的独立定义约定
// （主进程只通过 HTTP 与核心服务交互，不反向导入 services/core/config/index.ts），
// 两个主进程文件各自维护一份而不是互相 import，避免这两个本就该各自独立的模块产生耦合
//
// Stage 4（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"配置模型拆分：pinMode 不再是全局概念
// （阶段④）"）：旧的 pinMode 曾经是"全局置顶模式"，但它只被 evaluateChatPresence 读取过，
// evaluatePetPresence 从未读过它——用户把它设成"关闭"，小人照样跳屏避让。拆成两个独立概念：
//   chatPinMode        只管聊天窗口的置顶策略（'off'/'smart'/'always'，取代旧的
//                      'off'/'dodge-fullscreen'/'always-on-top'）
//   petAvoidanceEnabled 只管桌宠是否智能让路——TDD 原文"刻意不暴露 petAlwaysOnTop"：桌宠置顶
//                      与否不是用户需要控制的维度，是否自动避让才是
type ChatPinMode = 'always' | 'smart' | 'off'

interface WindowBehaviorConfig {
  chatPinMode: ChatPinMode
  petAvoidanceEnabled: boolean
  appRules: AppRule[]
}

const CORE_URL = 'http://127.0.0.1:3000'

// setAlwaysOnTop 不传 level 时默认是 'floating'，在 Windows 上不足以压过全屏应用。
//
// 注意 Windows 上 level 的真实语义与文档的「档位」措辞不同，已核对 Electron v42.4.1 源码：
// Chromium 的 DesktopWindowTreeHostWin::SetZOrderLevel 把整个枚举折叠成布尔
// （kNormal = 普通，其余一律 topmost），所以 'pop-up-menu' / 'screen-saver' / 'dock'
// 在 Windows 上逐字节等价，不存在「更高档位」。level 唯一的作用是 NativeWindowViews
// 里的一个二值判断：'floating' / 'torn-off-menu' / 'modal-panel' / 'main-menu' / 'status'
// 这五个会额外执行 SetWindowPos(hwnd, Shell_TrayWnd, ...) 把窗口锚到任务栏之后，其余不做。
// 而 MSDN SetWindowPos 明确：topmost 窗口一旦被排到任何非 topmost 窗口之后就不再是
// topmost——全屏应用在前台时 shell 会把任务栏降为非 topmost，于是 'floating' 那步锚定
// 会把本窗口整个踢出 topmost 组。这才是「'floating' 压不住全屏」的真实机制，
// 换成 'screen-saver' 生效的原因是不再做这步锚定，而非获得了更高的 z-order。
// 已知它并非绝对：electron#38020 报告过 Kiosk 模式下按 Windows 键时任务栏仍会盖在
// 'screen-saver' 级窗口之上。
// 独占全屏（DirectX exclusive fullscreen，多见于较老/未走 DXGI flip model 的游戏）在
// Windows 上物理上完全绕过桌面合成器，任何应用层窗口（不论 topmost 级别）都不可能盖住它，
// 这是平台限制，不是这次改动能解决的缺陷。
// 至于"不压过任务管理器/UAC 提示"：UAC 授权提示运行在独立的安全桌面（Secure Desktop）上，
// 与普通桌面完全隔离，任何窗口设置都无法触及；任务管理器本身不是 topmost 窗口，只要
// setAlwaysOnTop(true) 生效（不论传哪个 level）就已经会盖住它——这不是 level 选型能决定的
// 取舍，'screen-saver' 相比 'floating' 不会让任务管理器更容易被盖住
const PIN_LEVEL: NonNullable<Parameters<BrowserWindow['setAlwaysOnTop']>[1]> = 'screen-saver'

// 幂等置顶：记录"上次实际调用 setAlwaysOnTop 时传的值"，只在目标态与它不同时才真正调用。
// 已核实 setAlwaysOnTop 没有内部短路——每次调用都会真的发一次 SetWindowPos(HWND_TOPMOST)，
// 把本窗口重新抬到 topmost 组的最顶端；而 Windows topmost 组内谁最后被抬起谁在最上层。
// 之前 500ms 轮询驱动的 handlePinMode 每个 tick 都无条件重抬，导致晚出现的托盘溢出面板/
// 右键菜单等系统浮层被压在下面——这不是设计出来的行为，只是轮询架构的副产品。改成幂等后
// 停止重抬，晚出现的浮层天然在上，不需要额外的检测逻辑。这条幂等缓存在 Stage 2 之后仍然
// 是"零 API 调用"要求的一部分——evaluateChatPresence 现在每次都会调用 applyAlwaysOnTop，
// 靠这里的幂等短路保证目标态不变时不会真的调用 setAlwaysOnTop
//
// ⚠️ 这是"MintBot 自己上次调用时传的值"，不是从系统读回的真实置顶态。若外部因素把
// MintBot 的 topmost 清掉但没触发 lastAppliedOnTop 更新（已知平台缺陷：Win11 24H2 上
// WinUI3 窗口会被其它进程新设的 TOPMOST 挤掉而不触发自身状态变化，样式位保留），缓存会
// 一直认为"已经是 true"而不再重抬，直到目标态本身发生变化。本轮判断是接受这个风险，不
// 加窗口 show/focus/restore 时的强制重抬自愈：① 该缺陷报告针对 WinUI3 窗口，MintBot 是
// 标准 Chromium/Electron 窗口，是否同样受影响未经实机验证；② 用户点击/聚焦本窗口时
// Windows 通常会把它带回 topmost 组顶端，已经是一种自然的自愈路径。之后如果实机验证到
// 确有此问题，再回来加对应监听
//
// ⚠️ 另一条更实际的脱节风险：这是**模块级**缓存，没有与窗口实例绑定。若同一进程内
// createWindow() 被再次调用（目前唯一触发点是 index.ts 里 app.on('activate') 且
// getAllWindows().length === 0），新窗口的真实置顶态是 Electron 默认的 false，而这里
// 仍残留旧窗口的值——若残留值恰好是 true，下一次 applyAlwaysOnTop(newWin, true) 会被
// 误判为"已经是 true"而短路，新窗口永远不置顶，直到目标态翻转一次才被动纠正。
// 当前 Windows 运行时下这条路径不可达：close 只隐藏不销毁（index.ts 的 close 拦截），
// 而 window-all-closed 在非 darwin 上直接 app.quit()，两者不会同时成立。**这个缓存
// 严格来说不是跨窗口安全的，只是被 close 拦截的设计恰好规避了**——日后若改动窗口
// 销毁/重建策略，必须回来处理（最简做法是 createWindow 时把这里重置为 null）
// 按窗口分开记：两个窗口共用一份缓存会让其中一个的目标态把另一个的幂等短路带偏（Pet 刚被设成
// true，Chat 想设 true 时会被误判成"已经是 true"而跳过）
const lastAppliedOnTop: Record<WindowKey, boolean | null> = { overlay: null, chat: null }

function applyAlwaysOnTop(win: BrowserWindow, windowKey: WindowKey, onTop: boolean): void {
  if (lastAppliedOnTop[windowKey] === onTop) return
  win.setAlwaysOnTop(onTop, PIN_LEVEL)
  lastAppliedOnTop[windowKey] = onTop
}

const DEFAULT_CONFIG: WindowBehaviorConfig = {
  chatPinMode: 'off',
  petAvoidanceEnabled: true,
  appRules: [],
}

// 内存缓存：启动时 initWindowBehaviorConfig() 拉一次，之后由 index.ts 的 SSE 订阅在收到
// window-behavior-changed 帧时通过 updateCachedWindowBehaviorConfig() 替换。取不到/还没
// 初始化完成之前用默认值兜底，不阻塞 evaluateChatPresence 的其它逻辑
let cachedConfig: WindowBehaviorConfig = DEFAULT_CONFIG

// 供 electron/main/displayStateMap.ts（经 foregroundWorldModel.ts 转发）的 blocker 建立/
// 校验复用同一份用户规则真源——不允许两个模块各自缓存一份配置，那样配置变更后必然
// 出现两边生效时刻不一致的漂移。只读快照，不返回内部对象引用之外的任何东西
export function getWindowBehaviorRules(): { appRules: AppRule[] } {
  return { appRules: cachedConfig.appRules }
}

// ---------------------------------------------------------------------------------------------
// 启动门控（docs/MintBot_TDD.md 同节"启动门控"一节，阶段②）：DisplayStateMap 不跨应用重启
// 存活，preferredDisplayId 却跨存活。若门控在启动时判定"整机此刻有东西在占据屏幕"
// （electron/main/startupGate.ts 的 shouldDistrustHomeAtStartup），evaluatePetPresence 在
// 门控重新打开之前一律不落点/不显示——只有 Pet 受这条门控约束，Chat 窗口的初始显示完全
// 由用户操作决定（ready-to-show → show()，见 index.ts），不受此影响，见任务范围说明
// ---------------------------------------------------------------------------------------------
let startupGateOpen = true

export function closeStartupGate(): void {
  startupGateOpen = false
}

// 幂等：门控已经开着时再调用一次是 no-op。两个调用点（首次 external 观测 / 超时）都可能
// 先后触发，第二次调用不应该产生任何额外效果
export function openStartupGate(): void {
  startupGateOpen = true
}

// ---------------------------------------------------------------------------------------------
// applied 状态：每个窗口只记"上一次真正执行过移动的目标显示器"（displayId）与"上一次求出的
// presence"（仅 Chat 需要，见 evaluateChatPresence 的可见性守卫），不做更多。可见性/置顶态
// 都改为每次直接查询真实窗口状态（BrowserWindow.isVisible()/isFocused()），不再维护单独的
// 记忆值——这正是 diffPetState/diffChatState（electron/main/desktopPresence.ts）头部注释
// 强调的"没有理由为廉价的同步查询单独维护一份可能脱节的缓存"
// ---------------------------------------------------------------------------------------------
let appliedPetDisplayId: number | null = null
let appliedChatDisplayId: number | null = null
let appliedChatPresence: 'SHOWN' | 'NORMAL' | 'SUPPRESSED' | null = null

// 大小写不敏感匹配：Windows 文件名本身不区分大小写，QueryFullProcessImageNameW 实际返回的
// 大小写不保证跟用户通过设置页文件选择框选中时存下来的大小写一致（同 activeWindowMonitor.ts
// 自身排除 MintBot 窗口时已经踩过的同一个坑）——按区分大小写比较会导致用户规则静默永远不
// 命中，比检测不到全屏还危险。
//
// initWindowBehaviorConfig（冷启动）与 updateCachedWindowBehaviorConfig（配置变更）都在
// 拿到新配置后立即调用一次 evaluateDesktopPresence——不能指望轮询/校验循环靠"下一次触发"
// 来补上：这两个时机（冷启动 / 用户在设置页或托盘菜单里操作）前台大概率就是 MintBot 自己，
// activeWindowMonitor 会因为自我排除产生 self 观测，不会触发新的 external 变化。
//
// Stage 4：这两个函数现在都传入 overlayWindow，调 evaluateDesktopPresence（同时驱动 Pet 与
// Chat 两个 resolver），不再只调 evaluateChatPresence——`petAvoidanceEnabled` 从
// true 切到 false 时，"退出托管"的恢复同样必须立即生效，不能等下一次 500ms 轮询/1500ms
// blocker 复查才碰巧触发，理由与 chatPinMode 离开 'smart' 时聊天窗口必须立即恢复完全一致
export async function initWindowBehaviorConfig(mainWindow: BrowserWindow | null, overlayWindow: BrowserWindow | null): Promise<void> {
  try {
    const response = await fetch(`${CORE_URL}/config/window-behavior`)
    if (response.ok) {
      cachedConfig = await response.json()
    }
  } catch (err) {
    console.error('[WindowBehavior] Failed to fetch initial config, using defaults:', err)
  }
  // isDestroyed 守卫：evaluatePetPresence/evaluateChatPresence 各自对 null/isDestroyed 的窗口
  // 做了守卫，这里的 try/catch 只是兜底——本函数在 await fetch 前后跨了异步，mainWindow/
  // overlayWindow 是调用时刻捕获的引用，理论上可能在这期间被销毁，这是一个 fire-and-forget
  // 调用（调用点不 await），不能让任何非预期抛错变成未捕获的 rejection。与本文件/index.ts 中
  // 其它跨异步使用窗口引用的地方同一写法（positionOnChatDisplay、设置窗口那条 handler）
  try {
    evaluateDesktopPresence(mainWindow, overlayWindow)
  } catch (err) {
    console.error('[WindowBehavior] Failed to apply pin state:', err)
  }
}

// 由 index.ts 的 SSE 订阅在收到 window-behavior-changed 帧时调用，直接替换整份缓存——
// 广播的 payload 就是服务端已经校验+合并过的完整 WindowBehaviorConfig（见
// services/core/routes/windowBehavior.ts），这里不需要再做一次字段校验。
//
// 这个"payload 恒完整"的前提由 services/core/config/index.ts 的 updateWindowBehaviorConfig()
// 保证：它必须以 getWindowBehaviorConfig()（已经过 mergeWindowBehaviorConfig 补齐默认值的
// 当前配置）而非磁盘原始 section 作为合并起点。这条前提失效过一次——服务端一度还在返回旧形状
// （pinMode/fullscreenWhitelist/blacklist），主进程照单全收之后 appRules 是 undefined，
// displayStateMap.ts 的 findRule() 在 500ms 前台轮询里每一轮抛一次 uncaughtException，
// 同时 petAvoidanceEnabled 是 undefined（falsy）让桌宠避让全程静默关闭。主进程这侧没有任何
// 编译期信号能感知服务端是否又出现绕开该合并逻辑的新写入路径——改动 updateWindowBehaviorConfig
// 或给 windowBehavior 新增写入通道时，需要重新核对这条假设。
//
// mainWindow/overlayWindow 传入是为了立刻处理"切走 'smart' 模式时聊天窗口/关闭
// petAvoidanceEnabled 时悬浮窗正卡在 resolver 决定的状态"这两个需求——理由同
// initWindowBehaviorConfig 头注释
export function updateCachedWindowBehaviorConfig(
  config: WindowBehaviorConfig,
  mainWindow: BrowserWindow | null,
  overlayWindow: BrowserWindow | null
): void {
  cachedConfig = config
  evaluateDesktopPresence(mainWindow, overlayWindow)
}

// ---------------------------------------------------------------------------------------------
// moveToDisplay：Stage 2 起改名自 moveToNonFullscreenDisplay，角色也随之收窄——旧版本自己
// 选目标显示器（excludeDisplayId 之外的第一块），现在选哪块屏完全是 resolver
// （electron/main/desktopPresence.ts 的 resolvePetDesiredState/resolveChatDesiredState）的
// 职责，这个函数只负责"把窗口移到调用方已经选好的 targetDisplayId"，见任务要求"resolver
// 选择目标显示器，执行器只负责移动"
// ---------------------------------------------------------------------------------------------

// Fix A（second rework pass）：the previous rework re-stamped a single "last programmatic move"
// timestamp in animateTo's onComplete, which opened a full fresh 1000ms cooldown at the END of
// every automatic relocation — a user grabbing the window right after it jumped, and completing
// the drag within that window, had their drop silently discarded (persistBoundsNow's guard) AND
// their drag never counted as user activity (handleWindowMoved's guard), which also defeated the
// conservative-validation trigger and the skip-mid-drag-relocate guard. Root cause: a single time
// window was being used to answer "was this my own move?" when for animated moves we actually
// KNOW the answer. Replaced with explicit state:
//
//   programmaticMoveInFlight  windowKey is in this set for exactly the duration of an in-progress
//                             animateTo() call (added right before calling it, removed in
//                             onComplete). While present, every 'moved' this window fires is
//                             known — not guessed — to be our own setBounds.
//   programmaticQuietUntil    an absolute expiry timestamp, for the two cases that have no
//                             "animation finished" signal to key off of (see the two constants
//                             below). Written only through markProgrammaticQuiet().
//
// isProgrammaticMoveEcho (desktopPresence.ts) is the pure classifier over these two inputs —
// pinned by unit tests instead of only being exercised indirectly by reading timers.
const programmaticMoveInFlight = new Set<WindowKey>()
const programmaticQuietUntil = new Map<WindowKey, number>()

// Single writer for programmaticQuietUntil — stores an absolute expiry (now + ms), not a
// "last touched at" timestamp, so callers never have to re-derive the window length at the read
// site (that re-derivation, with two different durations now in play, is exactly what caused
// Fix A's regression).
// 只延长、绝不缩短——判断本身抽成 extendQuietUntil（desktopPresence.ts）单测，见该函数注释
function markProgrammaticQuiet(windowKey: WindowKey, ms: number): void {
  programmaticQuietUntil.set(
    windowKey,
    extendQuietUntil(programmaticQuietUntil.get(windowKey) ?? 0, Date.now(), ms)
  )
}

// Fix 1 (third rework pass, ts-backend-reviewer/integration-reviewer rework — the same defect
// found independently by both): preempting an in-flight animation used to release the bracket the
// PREEMPTING call had just opened, not the one being preempted. animateTo's first action is
// existingCancel(), which synchronously runs the OLD invocation's snap() -> onComplete
// (which used to just do programmaticMoveInFlight.delete(windowKey)) — but programmaticMoveInFlight
// is keyed by windowKey alone, so that delete wiped out the entry the NEW call had just added a
// moment earlier (moveToDisplay/runPetEdgeController/persistBoundsNow all do
// `programmaticMoveInFlight.add(windowKey)` BEFORE calling animateTo). The replacement animation
// then ran with no in-flight marker at all for most of its own duration, covered only by the short
// PROGRAMMATIC_ECHO_TAIL_MS tail anchored to the CANCELLATION instant rather than to the
// replacement's own completion — every 'moved' fired by its own remaining frames was misclassified
// as user input, reachable today (without Stage 4) whenever two relocations land within one
// animation's duration, which the 500ms foreground poll and the 1500ms validation loop can produce
// on their own.
//
// Fixed with a per-window generation counter, bumped by beginProgrammaticMove() every time a new
// programmatic move begins — including replacements. Because the new call bumps the generation
// BEFORE calling animateTo (which is what runs the old call's onComplete via existingCancel()),
// the old onComplete closes over a now-stale generation number and its release becomes a no-op;
// only the completion whose generation still matches the latest one for that windowKey actually
// clears the bracket.
const programmaticMoveGeneration = new Map<WindowKey, number>()

// Fix 2 (third rework pass): a real user drag starting while an animation is still in flight for
// that window must not have its drop silently discarded. Primary fix: retain the cancel function
// animateTo returns (previously discarded — all four call sites below used to call animateTo for
// its side effect only) so windowDragMonitor.ts's WM_ENTERSIZEMOVE hook (wired in index.ts, via
// cancelProgrammaticMoveOnDragStart below) can end the animation — and release its bracket — the
// moment the user grabs the window, before any 'moved' from the real drag can arrive. See
// handleWindowMoved's own guard (Fix 2b) for the belt-and-braces half of this fix.
const activeAnimationCancelFor = new Map<WindowKey, () => void>()

// Fix 1: single helper used by all four call sites that start a programmatic move (moveToDisplay,
// runPetEdgeController's two branches, persistBoundsNow's rollback) — the duplication of this
// add-before/delete-in-onComplete bookkeeping across four call sites is exactly what let the
// preemption bug above hide through three prior review rounds. Returns the onComplete callback to
// pass into animateTo; callers must still separately store animateTo's returned cancel function
// into activeAnimationCancelFor themselves — via setActiveAnimationCancelIfCurrent below, not a
// bare .set() (this helper does not call animateTo itself, since the four call sites pass
// different targets/instant options to it).
//
// Stage 4 prerequisite fix (docs/MintBot_TDD.md 阶段④开工前必须先处理的一处已知隐患 +
// 实机验证项第 3 条): onComplete reports back, via its boolean return value, whether THIS
// invocation was the one that actually released the bracket ("current" — no newer programmatic
// move for this windowKey has started since) as opposed to a no-op because it was superseded.
// moveToDisplay/runPetEdgeController use this to gate a deferred continuation (re-running
// evaluatePetPresence/settlePetPresence once the animation genuinely settles) so a
// stale/superseded completion can never trigger one — see moveToDisplay's onSettled wiring below.
// animateTo's own onComplete parameter type is `() => void`, so a caller that doesn't need the
// boolean (persistBoundsNow's rollback is the only remaining one — see Resolver/Controller 边界
// 修正之后，runPetEdgeController 的两个分支都改为读这个布尔值来决定要不要调用
// settlePetPresence(reevaluate: true)，不再有"不需要它"的分支) can keep passing onComplete
// directly with no changes on their end.
//
// Fix 3 (fourth rework pass, ts-backend-reviewer): generation is now also returned alongside
// onComplete — see setActiveAnimationCancelIfCurrent below for why callers need it. Latent bug
// this closes: every call site used to write `activeAnimationCancelFor.set(windowKey, cancel)`
// unconditionally, AFTER animateTo(...) returns. If animateTo's onComplete callback ever ran
// synchronously for a still-current generation (not reachable today — only the isDestroyed entry
// guard and options.instant complete synchronously, and neither is paired with an onSettled that
// could itself trigger a nested programmatic move — but structurally possible the day something
// does), a recursive evaluatePetPresence invoked from inside that onComplete (via onSettled) would
// start ITS OWN programmatic move for the same windowKey first, bumping the generation and
// registering ITS cancel function — and then the outer, now-stale write would clobber it with the
// already-finished outer call's cancel. A later real drag-start would then invoke that stale,
// already-finished cancel instead of the one actually in flight, silently doing nothing and
// reintroducing the exact bug Fix 2 above was built to close.
function beginProgrammaticMove(windowKey: WindowKey): { generation: number; onComplete: () => boolean } {
  const generation = (programmaticMoveGeneration.get(windowKey) ?? 0) + 1
  programmaticMoveGeneration.set(windowKey, generation)
  programmaticMoveInFlight.add(windowKey)
  return {
    generation,
    onComplete: function onProgrammaticMoveComplete(): boolean {
      // A newer call for this windowKey has since bumped the generation further — this completion
      // belongs to a superseded invocation (either preempted via animateTo's own existingCancel(),
      // or cancelled via cancelProgrammaticMoveOnDragStart below) and must not release the bracket
      // the newer call is relying on.
      if (programmaticMoveGeneration.get(windowKey) !== generation) return false
      programmaticMoveInFlight.delete(windowKey)
      markProgrammaticQuiet(windowKey, PROGRAMMATIC_ECHO_TAIL_MS)
      return true
    },
  }
}

// Fix 3 (fourth rework pass): the generation-guarded write itself — only record this invocation's
// cancel function if `generation` (captured from beginProgrammaticMove at the same moment
// onComplete was) is still the latest one for this windowKey at the point animateTo returns. See
// beginProgrammaticMove's own comment for the scenario this guards against. All four call sites
// that start a programmatic move go through this instead of writing activeAnimationCancelFor
// directly, for the same "one helper, not four copies of the same bookkeeping" reason Fix 1 already
// established for beginProgrammaticMove itself.
function setActiveAnimationCancelIfCurrent(windowKey: WindowKey, generation: number, cancel: () => void): void {
  if (programmaticMoveGeneration.get(windowKey) === generation) {
    activeAnimationCancelFor.set(windowKey, cancel)
  }
}

// Fix 2: called from index.ts's WM_ENTERSIZEMOVE wiring (via windowDragMonitor.ts) the instant a
// real drag begins on this window. Invoking the stored cancel function runs animateTo's snap()
// synchronously — bounds jump straight to the animation's target, opacity to 1 — and
// onProgrammaticMoveComplete above fires and releases the bracket (its generation still matches,
// since nothing newer has started in between), the same terminal path as any other natural
// completion, not a special one. Safe to call even when no animation is in flight for this window
// (map miss — optional chaining no-ops) or one already finished naturally (the stored cancel
// function is a safe no-op past completion, per animateTo's own "cancel is idempotent" contract).
export function cancelProgrammaticMoveOnDragStart(windowKey: WindowKey): void {
  activeAnimationCancelFor.get(windowKey)?.()
}

// 显示器拓扑变化（display-added / display-removed / display-metrics-changed）之后的静默窗口。
//
// 为什么需要它：显示器被拔掉时，Windows 会**自己**把留在那块屏上的窗口重新摆到别的屏，并
// 发出原生 'moved'。这个事件与用户真实拖拽在 Electron 层完全无法区分，而它一旦走到
// persistBoundsNow，就会被当成一次用户放置——落点是系统挑的、不是用户选的，却可能被写进
// 偏好表，甚至在被判定为"在家拖拽"时改写 preferredDisplayId。把拓扑变化当成一次程序化扰动
// 并静默一段时间，是这里唯一可靠的处理方式：我们无法给那个事件打标记，只能按时间把它挡掉。
//
// 用 PROGRAMMATIC_MOVE_COOLDOWN_MS 同一档时长，理由也相同——这条路径同样**没有任何完成
// 信号**可以钩（系统重摆窗口不经过 animateTo），只能靠时间窗兜底
export function markTopologySettle(): void {
  markProgrammaticQuiet('overlay', PROGRAMMATIC_MOVE_COOLDOWN_MS)
  markProgrammaticQuiet('chat', PROGRAMMATIC_MOVE_COOLDOWN_MS)
}

function isProgrammaticEchoFor(windowKey: WindowKey): boolean {
  return isProgrammaticMoveEcho(
    programmaticMoveInFlight.has(windowKey),
    programmaticQuietUntil.get(windowKey) ?? 0,
    Date.now()
  )
}

// 供 index.ts 在 new BrowserWindow(...) 之后立刻调用一次。构造函数的 x/y/width/height
// 同样是一次「程序放置窗口」，和 animateTo 没有本质区别，却一直没有被记进这个冷却窗口：
// Windows 会在窗口刚落到某块屏上时异步发一次 WM_DPICHANGED 校正（见 windowAnimation.ts
// 顶部关于 electron#27651 的说明），那次校正触发的 moved/resize 到达 handleWindowMoved 时
// 若不在冷却窗口内，漂移后的矩形会被当成用户手动调整写进偏好表。
//
// 这条路径没有任何"完成"信号可用——它不经过 animateTo，没有 onComplete 可以钩——因此只能
// 靠一个时间窗口兜底，这正是 PROGRAMMATIC_MOVE_COOLDOWN_MS（而不是下面更短的
// PROGRAMMATIC_ECHO_TAIL_MS）存在的理由：它必须盖住整段"窗口构造 → 可能迟到的
// WM_DPICHANGED"，而不是仅仅"最后一帧事件投递延迟"
export function markProgrammaticWindowPlacement(windowKey: WindowKey): void {
  markProgrammaticQuiet(windowKey, PROGRAMMATIC_MOVE_COOLDOWN_MS)
}

const PROGRAMMATIC_MOVE_COOLDOWN_MS = 1000

// Fix A：animateTo 的 onComplete 之后仍需要一个短尾巴，但理由跟上面那个 1000ms 完全不同，
// 值也因此完全不同。onComplete 触发时窗口的最终 setBounds/setOpacity 已经真正执行完毕——
// 剩下唯一需要吸收的只是这最后一帧 'moved' 事件本身的投递延迟（Electron/Chromium 把原生
// WM_MOVE 转成 JS 事件排到下一个 tick 之类的普通异步延迟），不是 PERSIST_DEBOUNCE_MS 那
// 300ms 的落盘防抖——防抖发生在 handleWindowMoved 之后，而 Fix A 把 handleWindowMoved 本身
// 改成了在识别出回声时提前 return（见该函数），落盘防抖压根不会被排上，因此不需要覆盖它。
// 150ms 远小于 1000ms，是刻意的：这条尾巴只需要盖住事件投递延迟，开得越宽，"用户在动画
// 结束后立刻抓住窗口"这个 Fix A 本身要修的场景就被吞掉得越多
const PROGRAMMATIC_ECHO_TAIL_MS = 150

// "最近一次合法的临时摆放"记录（用户所说的 lastValidTemporaryPlacement）：只在窗口不在
// preferredDisplayId 上时才有值，见 notePlacement。持仓的是 resolveDragOutcome 判定为
// 'reject' 时的回滚目标——不是固定的避难屏 B，因为避难期间用户可能合法地拖动过好几次，
// 真正该回滚到的地方是"最近一次真的被接受的落点"，不是这次 episode 最初的那一个
const lastValidPlacement = new Map<WindowKey, { displayId: number; bounds: Electron.Rectangle }>()

// 唯一的写入口。规则：displayId === effectiveHomeDisplayId（在家）时删除记录——在家没有
// "临时摆放"这个概念可以回滚；否则记录下来。调用点见 moveToDisplay（自动避难落点）与
// persistBoundsNow（拖拽被接受的落点）。
//
// Fix 1（ts-backend-reviewer/integration-reviewer rework）：比较基准改为
// effectiveHomeDisplayId（resolveStartupDisplay(screen.getAllDisplays(),
// getPreferredDisplayId(windowKey)).id），跟 evaluatePetPresence/evaluateChatPresence/
// persistBoundsNow 用同一个"家"的定义，不再直接比较原始可空的 getPreferredDisplayId——后者
// 在从未提交过 home 的新档案上恒为 null，会让这里在任何显示器上都判定"不在家"，从而错误地
// 记一条本不该存在的可回滚记录。store-vs-delete 的判断本身抽成 isTemporaryPlacement
// （desktopPresence.ts）单测，这里只负责持有 lastValidPlacement 这份状态
function notePlacement(windowKey: WindowKey, displayId: number, bounds: Electron.Rectangle): void {
  const effectiveHomeDisplayId = getEffectiveHomeDisplay(screen.getAllDisplays(), windowKey).id
  if (isTemporaryPlacement(displayId, effectiveHomeDisplayId)) {
    lastValidPlacement.set(windowKey, { displayId, bounds })
  } else {
    lastValidPlacement.delete(windowKey)
  }
}

// 把 win 移到 targetDisplayId——查表拿该显示器的偏好位置/尺寸（getPreferredBounds），查到就
// 直接用；查不到（这块显示器第一次出现）就用 computeDefaultBoundsForDisplay 算一次默认值、
// 立刻存表，再用。目标显示器由调用方（evaluatePetPresence/evaluateChatPresence，最终来自
// resolver 的输出）保证仍然连接着；如果调用方传入一个已经不存在的 id（防御性场景，正常
// 不应该发生——resolver 的 allDisplayIds 参数就是当前 screen.getAllDisplays() 的结果），
// 这里直接跳过，不做任何事，也不抛错。
//
// 尺寸不由调用方传入的"当前窗口现场读数"决定——computeDefaultBoundsForDisplay 只依赖
// windowPositions.ts 里全局的密度锚点规则：目标屏该多大只取决于"当前连接的显示器都有谁"，
// 跟窗口从哪块屏跳过来的完全无关（history independent，见该函数注释）。
//
// 动画：走 animateTo 而不是直接 setBounds，悬浮窗和聊天窗口共用这个函数，因此两者的
// relocate 都会带上动画——跨屏走划出/飞入三段式，同屏走 windowAnimation.ts 的同屏补间
// （不再是瞬间跳，见该文件关于这次改动的说明）。不传 instant：这里调用时目标显示器可能与
// 窗口当前所在的屏相同（例如首次评估、窗口构造时已经落在 resolver 算出的目标屏上，见
// windowAnimation.ts evaluateAnimationGuards 定义处的调用链分析），也可能不同，两种情况
// 都应该有与之相称的动效，具体走三段式还是补间由 animateTo 内部按显示器 id 自行判断，这个
// 函数不需要、也不应该替调用方预判。
//
// Fix 2（third rework pass）：this now DOES retain animateTo's returned cancel function（见
// activeAnimationCancelFor 定义处注释）——中断处理（最小化/隐藏/关闭/销毁）仍然由
// windowAnimation.ts 内部的一次性监听自行兜底，不需要调用方持有它去处理那四类中断；持有它
// 是为了让 cancelProgrammaticMoveOnDragStart 能在真实拖拽开始的瞬间主动结束这次程序化动画，
// 不是为了重新实现中断处理
//
// onSettled（Stage 4 prerequisite, docs/MintBot_TDD.md 阶段④开工前必须先处理的一处已知隐患）：
// optional, invoked once this relocate genuinely settles — i.e. beginProgrammaticMove's completion
// reports this generation is still current, NOT just "animateTo called onComplete" (which also
// happens on every isDestroyed short-circuit and on drag-start cancellation, see that function's
// own comment). If a newer programmatic move for this windowKey starts before this one settles,
// onSettled is correctly never called — the newer move's own completion is what matters.
//
// Fix 2（fourth rework pass，both reviewers独立发现的同一个残留缺陷，Resolver/Controller
// 边界修正之后仍然成立）：evaluatePetPresence 对它触发的**每一次** relocate 都传入 onSettled，
// 不区分这次 relocate 之后 desired 是不是恰好 EDGE——理由：EDGE 退出恰好伴随一次跨屏 relocate
// （home 仍被挡、但另一块屏刚好空出来）这条路径若不转交 onSettled，moveToDisplay 只是**启动**
// 了一次跨屏动画（长达 500ms），却没有任何东西在它真正落定时驱动一次新的 evaluate 去让
// runPetEdgeController/settlePetPresence 收敛并广播。统一传入 onSettled（而不是为这条路径再
// 发明第二套"事后触发"机制）让它在这次 relocate 真正落定时驱动同一条已有的重新求值路径——
// 见调用点
function moveToDisplay(win: BrowserWindow, windowKey: WindowKey, targetDisplayId: number, onSettled?: () => void): void {
  const displays = screen.getAllDisplays()
  const target = displays.find(display => display.id === targetDisplayId)
  if (!target) return

  let bounds = getPreferredBounds(windowKey, target.id)
  if (!bounds) {
    bounds = computeDefaultBoundsForDisplay(target, displays, DEFAULT_WINDOW_SIZE[windowKey], windowKey)
    setPreferredBounds(windowKey, target.id, bounds)
  } else {
    // 存表坐标可能落在这块屏当前 workArea 之外（分辨率/排列在存下之后变过），不夹紧会把窗口
    // 送到够不着的地方。只夹紧本次使用的值、不回写偏好表——显示器恢复原状后用户原来的位置仍然
    // 应该有效，回写等于让一次临时的分辨率变化永久改写用户偏好
    bounds = clampBoundsToWorkArea(bounds, target.workArea)
  }
  notePlacement(windowKey, target.id, bounds)

  // Fix A/Fix 1: beginProgrammaticMove marks this window as "programmatic move in flight" BEFORE
  // calling animateTo, not just a timestamp — every 'moved' fired while the animation is running
  // (including every frame of the same-display tween or the cross-display exit/teleport/entrance
  // sequence) is known, not guessed, to be our own. Its returned onComplete callback clears the
  // in-flight marker and opens the short PROGRAMMATIC_ECHO_TAIL_MS tail to cover the final frame's
  // event-delivery latency — see the constants' definitions for why the two are different
  // durations — but only if this invocation's generation is still the latest one for this
  // windowKey (Fix 1: a preempting relocate must not have this superseded onComplete wipe out the
  // bracket the new one just opened). Fix 2: the returned cancel function is stored so a real drag
  // starting on this window can end the animation immediately (cancelProgrammaticMoveOnDragStart).
  const { generation, onComplete } = beginProgrammaticMove(windowKey)
  const cancel = animateTo(win, bounds, () => {
    const wasCurrent = onComplete()
    if (wasCurrent) onSettled?.()
  })
  setActiveAnimationCancelIfCurrent(windowKey, generation, cancel)
}

// ---------------------------------------------------------------------------------------------
// Resolver / Controller 边界修正（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"Resolver /
// Controller 边界：执行锁不是决策锁（阶段④ 修正）"）：本文件曾经用 wasEdgeLastEvaluate/
// rememberedPetEdgeSide 记"上一次 EVALUATE 的 desired 是不是 EDGE"，这是把 desired（intent）
// 误当成了 applied（fact）在用——两次 evaluate 之间可能有一次仍在飞的动画，"上一次 evaluate
// 求出的 desired"跟"窗口这一刻物理上真的处于什么状态"是两回事。
//
// 改为显式区分三者（TDD 原文"三者分工：intent / fact / process"）：
//   latestPetDesired      intent  —— resolver 每次都无条件写入，从不因为任何原因跳过
//   appliedPetPresence /
//   appliedPetEdgeSide     fact   —— 只在窗口物理上真的落定（settle）之后才更新，见 settlePetPresence
//   programmaticMoveInFlight（已存在，见上文）  process —— 当前是否有一次程序化移动尚未落定
//
// 派生的三条规则（同节）：
//   广播      跟 appliedPetPresence/appliedPetEdgeSide（fact），不跟 latestPetDesired
//   安全门    handleSuppressed 同时读 latestPetDesired 与 appliedPetPresence（intent ∪ fact）
//   物理执行  runPetEdgeController 从 fact（当前 bounds）向 intent（latestPetDesired）收敛
let latestPetDesired: DesiredPetState | null = null
let appliedPetPresence: PetPresence | null = null
let appliedPetEdgeSide: EdgeSide | null = null

// ---------------------------------------------------------------------------------------------
// EDGE hover（Stage 3 part 2 任务书 Task 2，见 desktopPresence.ts resolveEdgeHoverBounds 定义处
// 注释）：overlayEdgeHovered 是渲染层通过 'overlay:edge-hover' IPC 报告的"现在算不算 hover"，
// 只在 presence 真的是 EDGE 时才有意义。presence 离开 EDGE 时必须清掉（见下方
// runPetEdgeController 的 `!== 'EDGE'` 分支）——否则下一次重新进入 EDGE 会带着上一个 episode
// 遗留的展开状态，制造"莫名其妙一进 EDGE 就是展开的"这种诡异体验，也正是 TDD 原文
// "EDGE_HOVERED 不进入桌面呈现状态机"要求的：它的生命周期不能比 EDGE 本身更长
//
// Fix 2（第二次 rework，ts-backend-reviewer/integration-reviewer 各自独立发现）：上面这一处
// 清空只覆盖"presence 离开 EDGE"，没有覆盖"渲染层重新挂载"——渲染层重载/崩溃重生后总是以
// expanded: false 重新挂载，而它自己的 handlePortraitMouseLeave 在本地状态不是 expanded 时提前
// return，不会补发一次纠正性的 'overlay:edge-hover'(false)。若此时 presence 仍是 EDGE 且主进程
// 这份标志仍是 true（渲染层重载前恰好处于展开态），主进程会一直以为"仍在被 hover"，窗口卡在
// 展开态不收——这是第二个必须清空的地方，见 sendCurrentPetPresenceOnReady 头注释：渲染层刚
// 挂载完成这件事本身就等价于"当前没有存活的 hover 信号"，与 presence 离开 EDGE 是同一件事的
// 另一种成因，处理方式也相同——直接复位
// ---------------------------------------------------------------------------------------------
let overlayEdgeHovered = false

function boundsEqual(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

// EDGE 期间/退出时"没有被贴边收窄前的正常可视位置"的唯一定义——Task 2（Stage 3 part 2）
// 引入的 hover 展开与 episode 结束后的归位复用同一份计算，不允许出现第二套定义。这块显示器的
// 偏好坐标，跟 moveToDisplay 查表/查不到就算一次默认值同一套逻辑（见该函数），只是这里不会把
// 结果存表，纯粹借用来算 x。只取 fullBounds 的 x，y/宽高全部沿用 currentBounds——EDGE 全程
// 只改 x、y 保持不变是"Edge Placement"一节明确要求的不变量，hover 展开/收起、以及退出 EDGE
// 后的归位同样不该打破它
function computeEdgeFullBounds(
  target: Electron.Display,
  displays: Electron.Display[],
  currentBounds: Electron.Rectangle
): Electron.Rectangle {
  const fullBounds = getPreferredBounds('overlay', target.id) ?? computeDefaultBoundsForDisplay(target, displays, DEFAULT_WINDOW_SIZE.overlay, 'overlay')
  return {
    x: fullBounds.x,
    y: currentBounds.y,
    width: currentBounds.width,
    height: currentBounds.height,
  }
}

// runPetEdgeController：EDGE 维度的 Controller（阶段④修正后的模型）。只在 displayId 已经落定
// （调用方保证：见 runPetController，只有 transition.move === null 才会走到这里——「geometry
// rule」的落地点：依赖最终窗口几何的后续 transition，不在前一个 programmatic move settle 前
// 执行）时才被调用；EDGE 相关的 bounds 计算因此永远读到真实几何，不需要再靠
// programmaticMoveInFlight 去挡"顺带用了stale getBounds()"这一类错误——它压根不会被调用到那种
// 时刻。
//
// 本函数不再返回"该不该推迟广播"这个布尔值——PREREQ 1/PREREQ 2 这两条曾经的补丁在这个模型下
// 是自然性质，不是特判：广播只跟 appliedPetPresence/appliedPetEdgeSide（fact）走，由
// settlePetPresence 统一处理，进入与退出因此天然对称，不需要这里分别 return true/false 告知
// 调用方"这次要不要广播"。
function runPetEdgeController(
  overlayWindow: BrowserWindow,
  mainWindow: BrowserWindow | null,
  desired: DesiredPetState,
  isInteracting: boolean
): void {
  if (desired.presence !== 'EDGE') {
    // Task 2（Stage 3 part 2）：presence 一旦离开 EDGE，渲染层报告的这份 transient hover 状态
    // 立刻作废——见 overlayEdgeHovered 定义处注释。这条清理跟着 desired 走（不是 applied）：
    // 不需要等窗口真的展开落定才清掉这份"是否被 hover"的记忆，它只是下一次进入 EDGE 时不该
    // 继承的历史，跟广播的 fail-closed/fail-open 顾虑无关
    overlayEdgeHovered = false

    // Fix 1（this rework pass, ts-backend-reviewer/integration-reviewer 各自独立发现同一行的
    // 两种症状）：这里曾经是 `if (isInteracting) return`，排在结算 applied 之前——但 isInteracting
    // 为真时 desired.presence 恒为 'ACTIVE'（resolvePetDesiredState 决策树最前一档，见该函数
    // 定义处注释），于是那条提前 return 结构性地让 appliedPetPresence 永远到不了 'ACTIVE'：
    // ACTIVE 在这个类型里成了一个只能被广播、永远无法被 applied 记录的死状态。更隐蔽的后果——
    // 若一次 EDGE 归位/进入动画在用户抓起窗口的瞬间被打断（cancelProgrammaticMoveOnDragStart），
    // 中断动画的 onComplete 会先把 appliedPetPresence 结算成 'EDGE'，随后同一调用栈里触发的
    // reevaluate 一进这个分支就因为这条 return 卡住——applied 从此卡在 'EDGE' 上，直到下一次
    // 有机会跑到这里的 evaluate；handleSuppressed 由于持续读到"applied 是 EDGE"而继续抑制
    // 拖拽手柄，可能一路卡到拖拽结束都不会自愈，因为 index.ts 的拖拽结束回调此前也没有触发
    // 任何 re-evaluate（另见该回调新增的 evaluateDesktopPresence 调用）。
    //
    // isInteracting 应该抑制的只是"移动"——用户正抓着的窗口不该被这里任何 bounds 动画改变
    // 目标——不该抑制 applied 这个 fact 本身的结算。改为跟"没有 EDGE 归位动画要播"合并成同一个
    // 判断：appliedPetPresence 不是 EDGE，或者正在交互，两者都意味着"这次不需要、也不允许启动
    // 归位动画"，只需要让 applied 追上 desired 这一刻的真值（isInteracting 时恒为 'ACTIVE'）。
    // 只有 appliedPetPresence 确实是 EDGE 且没有在交互时，才继续往下走真正的归位动画路径。
    if (appliedPetPresence !== 'EDGE' || isInteracting) {
      // 上一次落定的状态本来就不是 EDGE（或者用户正在交互，物理位置不该被这里的动画改变）：
      // 没有贴边 bounds 需要归位。presence 标签本身仍可能需要更新（例如 AMBIENT -> HIDDEN，
      // 交互中的 AMBIENT/EDGE -> ACTIVE，或应用启动后的第一次落定）——不涉及任何动画，是
      // apply(applied, desired) 在 desired == applied 时不产生副作用这条义务里"本来就相等"
      // 的那一半；只有真正不相等时才调用 settlePetPresence（其内部的 presencePayloadChanged
      // 短路本身也会挡住无意义广播，这里提前判断只是省掉一次无意义的函数调用）
      if (appliedPetPresence !== desired.presence) {
        settlePetPresence(overlayWindow, mainWindow, desired.presence, null, false)
      }
      return
    }

    // 只约束"不重复启动冲突的 bounds 动画"：这个窗口这一刻若已经有一次程序化移动没有落定
    // （不论是这次 evaluate 之前就在飞的 EDGE 归位/hover 补间，还是别的原因），这里不再重新
    // 同步读 win.getBounds() 去算一次可能冲突的新目标——那个仍在飞的动画自己的 onComplete
    // 落定时会调用 settlePetPresence(reevaluate=true)，届时会重新走到这里，用真实几何收敛。
    // 注意：这条检查不影响 displayId 维度的 relocate 抢占——moveToDisplay/animateTo 已有的
    // 世代号机制专门处理"用一个新目标抢占一次仍在飞的 relocate"，那是合法的收敛路径，不是
    // 这里要挡的"重复启动"。走到这里时 isInteracting 恒为假（上面的合并判断已经排除了
    // isInteracting 为真的情形），因此下面这段归位动画不会移动一个用户正抓着的窗口
    if (programmaticMoveInFlight.has('overlay')) return

    const displays = screen.getAllDisplays()
    const target = displays.find(display => display.id === desired.displayId)
    if (!target) return

    const currentBounds = overlayWindow.getBounds()
    const restoredBounds = computeEdgeFullBounds(target, displays, currentBounds)

    if (boundsEqual(currentBounds, restoredBounds)) {
      // 已经在归位后的位置（例如收起前 hover 展开时其实已经等于这个位置）：不需要动画，
      // 直接落定
      settlePetPresence(overlayWindow, mainWindow, desired.presence, null, false)
      return
    }

    // 不传 instant：EDGE 退出是"探出来"，用户决定里明确要求动画的过渡之一。desired.displayId
    // 全程等于 home，这次调用因此总是同屏，走新的同屏补间，不是三段式
    const { generation, onComplete } = beginProgrammaticMove('overlay')
    const cancel = animateTo(overlayWindow, restoredBounds, () => {
      // 只有这次完成仍是最新世代（未被更新的程序化移动抢占）才真正落定——settlePetPresence
      // 的 reevaluate=true 让"落定之后 latestPetDesired 是否已经变了"这一步收敛义务自动生效，
      // 不需要在这里额外判断
      if (onComplete()) settlePetPresence(overlayWindow, mainWindow, desired.presence, null, true)
    })
    setActiveAnimationCancelIfCurrent('overlay', generation, cancel)
    return
  }

  // 防御性保留，今天结构性不可达：isInteracting 为真时 resolvePetDesiredState 决策树最前一档
  // 恒定返回 'ACTIVE'（见该函数），desired.presence 因此永远不可能在 isInteracting 为真的同时
  // 等于 'EDGE'——不会重蹈上面非 EDGE 分支那个 bug（那里 desired.presence 可以是 isInteracting
  // 触发的 'ACTIVE'，这里不行）。保留这行只是不因为"目前走不到"就拆掉这道防线，不是这次修复
  // 需要变动的地方
  if (isInteracting) return

  // 见上方非 EDGE 分支同一条注释：只挡"重复启动"，不挡 displayId 维度的合法抢占
  if (programmaticMoveInFlight.has('overlay')) return

  const displays = screen.getAllDisplays()
  const target = displays.find(display => display.id === desired.displayId)
  if (!target) return

  const currentBounds = overlayWindow.getBounds()
  const freshSide = resolveEdgeSide(currentBounds, target.bounds)
  // episodeStillActive 现在读 appliedPetPresence（fact：上一次真正落定的是不是 EDGE），
  // 不再读"上一次 evaluate 的 desired 是不是 EDGE"——两者在存在仍未落定的动画时会不一致，
  // 而这里要问的正是"窗口这一刻物理上是不是已经在 EDGE 里"
  const episodeStillActive = appliedPetPresence === 'EDGE'
  const stableSide = resolveStableEdgeSide(appliedPetEdgeSide, freshSide, episodeStillActive)

  const edgeBounds = computeEdgeBounds(currentBounds, target.bounds, stableSide, EDGE_VISIBLE_SLIVER_PX)
  const fullBoundsSameGeometry = computeEdgeFullBounds(target, displays, currentBounds)

  // 常规 evaluate 路径与 hover IPC 路径（下方 requestOverlayEdgeHover）共用同一个决策函数——
  // 这保证 hover 展开期间反复到来的 evaluate（500ms 前台轮询 / 1500ms blocker 复查）不会
  // 跟 hover 打架：只要 overlayEdgeHovered 没变，这里每次都收敛到同一个 fullBoundsSameGeometry，
  // 下面的幂等短路会让它们全部变成 no-op，而不是每次都把窗口收回贴边位置
  const desiredBounds = resolveEdgeHoverBounds(edgeBounds, fullBoundsSameGeometry, overlayEdgeHovered)
  if (boundsEqual(currentBounds, desiredBounds)) {
    settlePetPresence(overlayWindow, mainWindow, 'EDGE', stableSide, false)
    return
  }

  // 广播不在这里特判提前发出：进入 EDGE（含 hover 展开/收起）与退出 EDGE 现在走同一套
  // settlePetPresence——presence/edgeSide 字段本身恒等 applied，在动画结束前都不会变化；
  // 真正需要 fail-closed、必须立即生效的是 handleSuppressed，它由 evaluatePetPresence 顶部
  // 每次都基于 latestPetDesired 单独广播一次，不依赖这里的落定时机（见 computeHandleSuppressed
  // 定义处注释）
  const { generation, onComplete } = beginProgrammaticMove('overlay')
  const cancel = animateTo(overlayWindow, desiredBounds, () => {
    if (onComplete()) settlePetPresence(overlayWindow, mainWindow, 'EDGE', stableSide, true)
  })
  setActiveAnimationCancelIfCurrent('overlay', generation, cancel)
}

// settlePetPresence：唯一的 applied-state 写入口（presence/edgeSide 维度）。落定（fact 真正
// 改变，或确认本来就已经相等）之后才广播——这就是"广播跟 applied，不跟 desired"在这个维度上的
// 全部实现，进入/退出天然对称，不需要调用方各自记"这次要不要推迟"。
//
// reevaluate 只在"这次落定来自一个真正播放过的动画"时传 true——动画播放期间 latestPetDesired
// 可能已经变化，落定后必须检查"若 latestDesired != applied，重新 apply latestDesired"，这里
// 用重新调用 evaluatePetPresence 实现（resolver 无状态，重新求一次永远安全）。传 false 的情形
// 是"这一刻本来就已经等于目标，没有播放任何动画"——同一个事实在同一个 tick 内不会又变化，重新
// 求值只会是无意义的空转（且在测试的静态 getBounds() mock 下会误判"还没收敛"，见
// windowBehavior.test.ts 对应用例的说明），因此不重新求值
function settlePetPresence(
  overlayWindow: BrowserWindow,
  mainWindow: BrowserWindow | null,
  presence: PetPresence,
  edgeSide: EdgeSide | null,
  reevaluate: boolean
): void {
  appliedPetPresence = presence
  appliedPetEdgeSide = edgeSide
  maybeBroadcastPetPresence(overlayWindow)
  if (reevaluate) evaluatePetPresence(overlayWindow, mainWindow)
}

// ---------------------------------------------------------------------------------------------
// Hover 展开的渲染层 → 主进程入口（Stage 3 part 2 任务书 Task 2）。供 index.ts 在收到
// 'overlay:edge-hover' IPC 时调用。
//
// 守卫（任务书原文："Ignore hover requests when the pet is not EDGE. Make this a guard in
// main, not an assumption about renderer behaviour."）：改读 appliedPetPresence（fact：窗口
// 这一刻是不是真的已经落在 EDGE 里）而不是"上一次 evaluate 的 desired 是不是 EDGE"——hover
// 只有在窗口物理上已经收边之后才有意义，desired 已经变成 EDGE 但对应的收边动画还没落定时，
// 这里应该继续吞掉请求，等落定后 hover 才生效
//
// 展开/收起不单独走一条新的移动路径——重新调用 evaluatePetPresence 本身，让
// runPetEdgeController 用刚写入的 overlayEdgeHovered 重新算一次目标 bounds。这保证 hover
// 触发的移动与常规 evaluate 触发的移动永远收敛到同一个函数、同一个判断
// （resolveEdgeHoverBounds），不会出现"hover 路径这里没同步某个新加的规则"这类日后维护
// 两份逻辑不一致的风险
// ---------------------------------------------------------------------------------------------
export function requestOverlayEdgeHover(
  overlayWindow: BrowserWindow | null,
  mainWindow: BrowserWindow | null,
  hovered: boolean
): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  if (appliedPetPresence !== 'EDGE') return

  overlayEdgeHovered = hovered
  evaluatePetPresence(overlayWindow, mainWindow)
}

// ---------------------------------------------------------------------------------------------
// Presence 广播（Stage 3 part 2 任务书 Task 1）。lastBroadcastPetPresence 持有"上一次广播过
// 什么"，presencePayloadChanged（desktopPresence.ts）只回答"这次该不该广播"——跟本文件其它
// 幂等缓存（lastAppliedOnTop/appliedChatPresence）同一套写法，理由也一样：evaluate 本身每
// 500ms/1500ms 跑一次，desired 不变时不该产生任何副作用，广播也是一种副作用，必须一样受
// 这条约束管
// ---------------------------------------------------------------------------------------------
let lastBroadcastPetPresence: PetPresencePayload | null = null

const PET_PRESENCE_CHANGED_CHANNEL = 'desktop-presence:changed'

function broadcastPetPresenceIfChanged(overlayWindow: BrowserWindow, payload: PetPresencePayload): void {
  if (!presencePayloadChanged(lastBroadcastPetPresence, payload)) return
  lastBroadcastPetPresence = payload
  overlayWindow.webContents.send(PET_PRESENCE_CHANGED_CHANNEL, payload)
}

// 组装当前该广播的 payload（Resolver/Controller 边界修正）：presence/edgeSide 跟 applied
// （appliedPetPresence/appliedPetEdgeSide，fact），handleSuppressed 同时读 latestPetDesired
// 与 appliedPetPresence（intent ∪ fact，见 computeHandleSuppressed 定义处注释）。
// appliedPetPresence 为 null（从未落定过，例如启动门控刚打开、第一次 evaluate 还没跑完）时
// 用 'AMBIENT' 兜底——不广播任何东西也是一个选项，但这里选择"给一个安全、非 EDGE 的默认值"，
// 理由是 handleSuppressed 的计算不能因为 applied 还没初始化就出错（fail-closed 的安全门不能
// 因为一个纯粹的簿记空档而失效）；实践中这个分支只在应用生命周期最早的一瞬间可达
function currentPetPresencePayload(): PetPresencePayload {
  const presence = appliedPetPresence ?? 'AMBIENT'
  return {
    presence,
    edgeSide: presence === 'EDGE' ? appliedPetEdgeSide : null,
    handleSuppressed: computeHandleSuppressed(latestPetDesired?.presence ?? presence, presence),
  }
}

// 供 evaluatePetPresence 顶部（每次 resolver 求值后，不论是否落定）与 settlePetPresence
// （每次 applied 真正更新后）共用——两者都只是"这一刻该广播什么"的两个不同触发时机，具体
// payload 的组装规则只有一份，见 currentPetPresencePayload
function maybeBroadcastPetPresence(overlayWindow: BrowserWindow): void {
  broadcastPetPresenceIfChanged(overlayWindow, currentPetPresencePayload())
}

// 供 index.ts 在收到悬浮窗渲染层的 'overlay:presence-ready' 时调用——渲染层挂载（含重载后
// 重新挂载）完成、且已经注册好 'desktop-presence:changed' 监听之后各发一次，见
// preload/index.ts notifyOverlayReady 与 OverlayApp.tsx 对应挂载 effect 的调用顺序。
//
// 为什么补发 lastBroadcastPetPresence 是安全的（Fix 4b，第二次 rework：原注释把这里的安全性
// 论证成"补发那一条被错过的广播"，integration-reviewer 指出这不是它安全的真正原因，重写如下）：
// lastBroadcastPetPresence 由 broadcastPetPresenceIfChanged **无条件**写入——只要
// presencePayloadChanged 判定"变了"就更新，不看这一刻有没有渲染层在监听、甚至不看
// overlayWindow 是否已经被销毁。换句话说，它任何时刻持有的都是主进程当下算出的**最新真值**，
// 不是"最后一次成功发出去、被某个监听收到的值"。因此这里发生的不是"补发一条被错过的历史
// 广播"（如果渲染层重载期间 presence 变化了不止一次，被错过的历史广播根本不止一条，这个
// 字段也不会保留它们）——而是"渲染层刚挂载、没有任何存量信息，告诉它现在实际是什么"，一次
// level-triggered 的重新同步，不是 edge-triggered 的重放。这也是为什么它不需要关心"到底错过
// 了几次"：不管错过多少次，重新同步只需要最新这一次。
//
// 上面这条论证解决的是"该发什么值"；另一半——"这次发送会不会跟一次几乎同时发生的新广播
// 产生竞态"——原注释的论证仍然成立，原样保留：渲染层在发送 'overlay:presence-ready' 之前，
// 必须已经先用 ipcRenderer.on 注册好这个频道的监听（渲染层自己进程内的同步调用，不经过
// IPC），因此任何在主进程收到这条 'ready' 消息**之后**才发出的广播，一定会被这个已经注册好
// 的监听收到——不存在"广播先到、监听还没挂上"的窗口。lastBroadcastPetPresence 仍是
// null（例如启动门控还没打开、从未有过一次成功的 evaluate）时没有"当前值"可以补发，但这同样
// 不构成竞态——null 这件事本身保证了之后第一次真正跑完的 evaluate 一定会广播
// （presencePayloadChanged(null, 任何值) 恒为真），而那时渲染层的监听早已注册好，必然收得到。
//
// Fix 2（第二次 rework）：补发之前先强制清空 overlayEdgeHovered、并重新跑一次
// evaluatePetPresence——渲染层刚挂载这件事本身就是"当前没有存活的 hover 信号"，语义上与
// "presence 离开 EDGE"完全一样（见 overlayEdgeHovered 声明处注释），必须同样处理。不这样做的
// 后果：presence 是 EDGE、且渲染层重载前窗口正因为 hover 处于展开态时，主进程这份标志会一直
// 认为"仍在被 hover"——它只在 runPetEdgeController 判定 desired 离开 EDGE 时才清空，而重载后的
// 新渲染层不会补发一次 hover(false)（它的 handlePortraitMouseLeave 在本地展开状态为假时提前
// return），窗口从此卡在展开态，且每次 evaluate 都收敛到同一个展开目标、被 boundsEqual 短路，
// 不会自我纠正。重新跑 evaluatePetPresence（而不是只清标志）是为了让这次纠正**立即**体现在
// 窗口的真实 bounds 上，不必等下一次 500ms/1500ms 的常规轮询
export function sendCurrentPetPresenceOnReady(overlayWindow: BrowserWindow | null, mainWindow: BrowserWindow | null): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return

  overlayEdgeHovered = false
  evaluatePetPresence(overlayWindow, mainWindow)

  // 上面这次 evaluatePetPresence 内部可能已经广播过一次（如果重算出的值与上次广播的不同），
  // 于是这里的无条件补发会产生一条内容完全相同的重复消息。刻意不去重：渲染层对这条消息的处理
  // （写 ref + setIsDragHandleSuppressed）是幂等的，相同值不会引发重渲染；而为了省下这一条消息
  // 去引入"这一轮到底广播过没有"的判断，等于在 ready 这条本就是兜底的路径上再加一个可能算错的
  // 条件。补发必须是无条件的——它的全部意义就是"不管中间发生过什么，渲染层现在一定拿到最新值"
  if (lastBroadcastPetPresence === null) return
  overlayWindow.webContents.send(PET_PRESENCE_CHANGED_CHANNEL, lastBroadcastPetPresence)
}

// ---------------------------------------------------------------------------------------------
// 拖拽落盘：'moved'/'resize' 监听回调（index.ts 在创建 mainWindow/overlayWindow 时各自注册
// 一次）命中即认定用户真实拖动了窗口。Stage 2 起改用四行拖拽规则表（resolveDragOutcome，
// electron/main/desktopPresence.ts）判断这次拖拽该写哪些偏好字段——取代旧版本"跳屏期间
// （isDodgeParked）一律不写"的粗粒度豁免：那条豁免现在由规则表的"行 3"（temporaryRelocation
// 且落回避难屏本身）自然覆盖，见该函数头注释，不再需要一个单独的 isDodgeParked 概念
// ---------------------------------------------------------------------------------------------

// 落盘防抖。'moved' 与 'resize' 都汇到本函数，而**两者在一次拖拽里都是逐帧连续触发的**：
// 从上边/左边拖拽缩放会同时改变原点，Windows 会一路发 move。因此防抖必须放在这个公共入口，
// 而不是某一个监听点上——放在监听点只会保护到那一种拖法，另一种照样每帧一次同步
// writeFileSync + renameSync。按 windowKey 分别计时，聊天窗与悬浮窗互不干扰。
// PERSIST_DEBOUNCE_MS 本身定义在 windowPositions.ts（Fix 4），dragActivity.ts 的
// DRAG_END_TAIL_MS 从同一个值推导，不再各自维护一份
const persistTimers = new Map<WindowKey, ReturnType<typeof setTimeout>>()

// Fix C（second rework pass）：a recorded appliedDisplayId can go stale when the display holding
// the window is unplugged — Windows repositions the window itself and fires a native 'moved',
// and there is no ordering guarantee between Electron's display-removed dispatch and that OS
// 'moved'. If the 'moved' wins the race, a stale appliedDisplayId pointing at a now-disconnected
// display would make deriveDragContext read this as "dragged onto another display", silently
// committing that display as the new home with no user drag at all. Fixed at the source: every
// reader goes through this function, and it never hands back an id that isn't currently connected
// — so persistBoundsNow (via deriveDragContext), diffPetState/diffChatState, are all covered by
// construction rather than each needing to remember to re-check screen.getAllDisplays().
function appliedDisplayIdFor(windowKey: WindowKey): number | null {
  const recorded = windowKey === 'chat' ? appliedChatDisplayId : appliedPetDisplayId
  if (recorded === null) return recorded
  if (screen.getAllDisplays().some(display => display.id === recorded)) return recorded
  // Stale: the display this windowKey was last applied to is no longer connected. Drop the
  // record instead of just masking it for this one read — a null return with the stale value
  // still sitting in appliedPetDisplayId/appliedChatDisplayId would let a later caller that
  // forgets to route through this function see it again.
  clearAppliedDisplayIdFor(windowKey)
  return null
}

function setAppliedDisplayIdFor(windowKey: WindowKey, displayId: number): void {
  if (windowKey === 'chat') appliedChatDisplayId = displayId
  else appliedPetDisplayId = displayId
}

function clearAppliedDisplayIdFor(windowKey: WindowKey): void {
  if (windowKey === 'chat') appliedChatDisplayId = null
  else appliedPetDisplayId = null
}

// Fix C：called from index.ts's display-topology handler, before evaluateDesktopPresence — makes
// the correction not depend on a drag (persistBoundsNow) happening first, and not depend on
// evaluatePetPresence/evaluateChatPresence actually reaching their appliedDisplayIdFor read on
// this pass (e.g. the startup gate can short-circuit evaluatePetPresence entirely). Discards the
// return value — called purely for the drop-if-stale side effect inside appliedDisplayIdFor.
export function invalidateStaleAppliedDisplayIds(): void {
  appliedDisplayIdFor('overlay')
  appliedDisplayIdFor('chat')
}

// drag-end 的主动收敛。在最终 placement 已经落定（合法 drop 提交完成，或非法 drop 的回滚
// settle）之后调用一次，让桌面状态立刻重新求值，而不是等 1500ms 校验循环碰巧跑到。
//
// 三步顺序不能调换：
//   revalidateBlockersNow    此时拖拽尾巴仍然开着，isAnyDragInProgress() 为真，
//                            selectValidationMode 因此必定选中 conservative——不依赖
//                            isSelfForeground 那条腿（getActiveWindowInfo() 在 Win32 读取失败时
//                            返回 unavailable，会让它变成 false）
//   endDragTail              尾巴要覆盖的那段已经结束，收掉它，下一步才求得出非 ACTIVE 的
//                            desired 并执行 relocate
//   evaluateDesktopPresence  resolve latest desired + controller apply
function reconcileAfterDragPlacement(
  windowKey: WindowKey,
  mainWindow: BrowserWindow | null,
  overlayWindow: BrowserWindow | null
): void {
  revalidateBlockersNow()
  endDragTail(windowKey)
  evaluateDesktopPresence(mainWindow, overlayWindow)
}

function persistBoundsNow(
  windowKey: WindowKey,
  win: BrowserWindow,
  mainWindow: BrowserWindow | null,
  overlayWindow: BrowserWindow | null
): void {
  // 二线守卫（belt-and-braces），不再是主要防线。Fix A 之后主要防线在 handleWindowMoved：
  // 识别出程序化回声时提前 return，连落盘防抖定时器都不再排上，这个函数大多数时候根本不会
  // 被那类事件触发调用。这里保留是为了兜住"定时器在一次动画开始之前就已经排上"的情形——
  // 例如 evaluate 触发的 relocate 恰好发生在一次已经进入 300ms 防抖窗口的真实拖拽事件之后，
  // 计时器到期时窗口可能仍处于程序化移动中
  //
  // Fix 9（本轮 sweep 发现，独立于 EDGE 重构、今天即可复现）：这条守卫此前缺了
  // handleWindowMoved 已经有的同一条拖拽覆盖——`isProgrammaticEchoFor(k) &&
  // !isWindowDragInProgress(k)`。handleWindowMoved 故意放行一次真实拖拽穿过回声守卫（哪怕它
  // 恰好落在静默窗口内），排上 300ms 落盘防抖；300ms 后本函数在没有这条覆盖的情况下重新问了
  // 一遍同一个问题——而这一刻若仍处于静默窗口内（例如 markTopologySettle() 打开的 1000ms 静默
  // 窗口，任意一次显示器热插拔/分辨率变化都会触发），答案会翻回"是回声"，把 handleWindowMoved
  // 刚刚放行的这次拖拽在这里悄悄丢弃——正是那条覆盖当初要防的回归，只是挪到了 300ms 之后发生。
  // 修法：这里补上同一条覆盖，与 handleWindowMoved 保持逐字一致，不再各自维护一份不同的判断
  if (isProgrammaticEchoFor(windowKey) && !isWindowDragInProgress(windowKey)) return

  const bounds = win.getBounds()
  const displays = screen.getAllDisplays()
  const dropDisplayId = screen.getDisplayMatching(bounds).id

  // Fix 1（ts-backend-reviewer/integration-reviewer rework）：跟 evaluatePetPresence/
  // evaluateChatPresence 用同一个"家"的定义——resolveStartupDisplay(displays,
  // getPreferredDisplayId(windowKey)).id，永不为 null（首启从未提交过 home 时退回最大显示
  // 器）。此前这里直接用原始可空的 getPreferredDisplayId：新档案上它恒为 null，会让
  // temporaryRelocation 恒判为 false——哪怕 resolver 已经因为大屏被挡住而把窗口自动挪到了
  // 别的屏，这里仍然会把随后的拖拽误判成"在家"，把落点误提交成新的家，正是
  // homeDisplayCommit.ts 想要防的事。currentDisplayId/temporaryRelocation 的推导本身抽成
  // deriveDragContext（desktopPresence.ts）单测
  const effectiveHomeDisplayId = getEffectiveHomeDisplay(displays, windowKey).id
  const { currentDisplayId, temporaryRelocation } = deriveDragContext(
    appliedDisplayIdFor(windowKey),
    effectiveHomeDisplayId
  )

  const outcome = resolveDragOutcome(temporaryRelocation, currentDisplayId, dropDisplayId, getDisplayStateMap())

  if (outcome.kind === 'reject') {
    // 合法性校验没通过（这块屏此刻不能被完整摆放地占据）：不写任何偏好、也不写任何
    // bounds；不更新 appliedDisplayId——窗口即将被弹回去，我们的记录应该继续描述它实际会
    // 落在哪，而不是它此刻悬停的这个被拒绝的落点
    // lastValidPlacement 与 appliedDisplayId 在每条写入路径上都是同一个 displayId 成对更新的
    // （persistBoundsNow 的接受分支、evaluatePetPresence / evaluateChatPresence 经 moveToDisplay），
    // 而 appliedDisplayIdFor 只会返回仍然连着的显示器。因此走到这里时回滚目标必然存在且可达——
    // 不再检查它所在的显示器是否还在。临时屏断开会让 applied placement 失效并重新定基，
    // 那种情况下这次 drop 根本不是 temporaryRelocation，到不了 reject。
    const rollback = lastValidPlacement.get(windowKey)
    if (rollback) {
      const { generation, onComplete } = beginProgrammaticMove(windowKey)
      const cancel = animateTo(win, rollback.bounds, () => {
        if (onComplete()) reconcileAfterDragPlacement(windowKey, mainWindow, overlayWindow)
      }, { instant: true })
      setActiveAnimationCancelIfCurrent(windowKey, generation, cancel)
    } else {
      moveToDisplay(win, windowKey, currentDisplayId, () =>
        reconcileAfterDragPlacement(windowKey, mainWindow, overlayWindow)
      )
    }
    return
  }

  commitHomeDisplayFromDragOutcome(windowKey, outcome)
  if (outcome.boundsWriteDisplayId !== null) {
    setPreferredBounds(windowKey, outcome.boundsWriteDisplayId, bounds)
  }
  notePlacement(windowKey, dropDisplayId, bounds)

  // 不论上面两个偏好字段有没有被改写，窗口这一刻确确实实已经在 dropDisplayId 上——更新我们
  // 自己的"当前所在"记录，保持跟真实世界一致，供下一次 evaluate 的 diff 与下一次拖拽的
  // currentDisplayId 使用
  setAppliedDisplayIdFor(windowKey, dropDisplayId)

  reconcileAfterDragPlacement(windowKey, mainWindow, overlayWindow)
}

export function handleWindowMoved(
  windowKey: WindowKey,
  win: BrowserWindow,
  mainWindow: BrowserWindow | null,
  overlayWindow: BrowserWindow | null
): void {
  // Fix A：a recognized programmatic echo returns EARLY — no debounce timer scheduled at all.
  // Previously this scheduled the debounce timer unconditionally and relied on persistBoundsNow's
  // own guard to re-check 300ms later, which is exactly why the echo-tail window used to have to
  // be longer than PERSIST_DEBOUNCE_MS. With the early return here, PROGRAMMATIC_ECHO_TAIL_MS only
  // has to cover this event's own delivery latency (see its definition), not a debounce that no
  // longer gets scheduled for this event.
  //
  // Stage 3: this function used to also call noteUserDragActivity() here on every genuine (non-echo)
  // 'moved' event — that was the entire drag-activity heuristic (electron/main/dragActivity.ts's
  // "time since the last moved event" window). isWindowDragInProgress() (renamed, per-window, in the
  // second rework pass — see that file's own header comment) is now driven directly by
  // WM_ENTERSIZEMOVE/WM_EXITSIZEMOVE (electron/main/windowDragMonitor.ts, wired in index.ts), which
  // fire independently of 'moved' and independently of this function, so there is nothing left for
  // this function to drive.
  //
  // Fix 2b（third rework pass，belt-and-braces — primary 修法是上面
  // cancelProgrammaticMoveOnDragStart，在 WM_ENTERSIZEMOVE 触发的瞬间就直接取消这个窗口正在
  // 进行的程序化动画、释放它的 bracket，在真实拖拽产生任何 'moved' 之前就把动画收尾掉）：即使
  // 有了 primary 修法，这里仍然需要一道独立守卫——programmaticQuietUntil 的两条尾巴
  // （PROGRAMMATIC_ECHO_TAIL_MS/PROGRAMMATIC_MOVE_COOLDOWN_MS）是纯时间窗，不挂在任何动画实例
  // 上，一次真实拖拽完全可能在这类尾巴仍然生效期间开始并产生 'moved'（包括松手落盘的那一下）。
  // 一次真实拖拽正在进行是比回声分类更权威的信号——用户此刻的手就在窗口上，不该被任何时间窗
  // 覆盖：isWindowDragInProgress(windowKey) 为真时，即使 isProgrammaticEchoFor 也判定为真，
  // 这里也不能提前 return，否则这次拖拽的落点会被静默丢弃，且 appliedDisplayId 永远不会更新成
  // 窗口真实所在的位置
  if (isProgrammaticEchoFor(windowKey) && !isWindowDragInProgress(windowKey)) return

  const pending = persistTimers.get(windowKey)
  if (pending) clearTimeout(pending)
  persistTimers.set(windowKey, setTimeout(() => {
    persistTimers.delete(windowKey)
    if (win.isDestroyed()) return
    persistBoundsNow(windowKey, win, mainWindow, overlayWindow)
  }, PERSIST_DEBOUNCE_MS))
}

// ---------------------------------------------------------------------------------------------
// evaluateDesktopPresence：取代旧版本的 handleActiveWindowChange，是 index.ts 唯一需要调用的
// 入口——每次 DisplayStateMap 可能发生变化时（前台观测变化、blocker 校验、显示器拓扑变化）
// 都调用一次，本身应当是幂等且廉价的：不变的 desired 状态不会触发任何 Electron API 调用
// （由 diffPetState/diffChatState 保证，见其头部注释）
// ---------------------------------------------------------------------------------------------

// 悬浮窗 visibility 的重入护栏（第 8 条 sweep 发现，见 evaluatePetPresence 头注释的完整场景
// 描述）：overlayWindow.hide() 可能同步触发一个更早调用留下的、仍在飞的动画的中断
// （win.once('hide', onInterrupt) -> snap() -> onComplete -> onSettled），而 onSettled 正是
// () => evaluatePetPresence(...)——于是在这一行调用还没返回的时候，本函数被嵌套地再调用一次。
//
// 这个守卫只包住"应用 visibility"这一步，不包住整个 evaluatePetPresence（bounds 收敛那一段的
// 递归——moveToDisplay/runPetEdgeController 各自的 onSettled——是这个模型里合法、需要的收敛
// 机制，不是这里要挡的意外重入，见 settlePetPresence 定义处注释）。命中时说明我们正处在这类
// 嵌套调用里：latestPetDesired 已经在 evaluatePetPresence 顶部无条件刷新过，这里只需要原样
// 返回——外层这次仍在执行的调用会在它自己的 hide()/showInactive() 调用返回之后继续往下走，
// 用同一份（未变化的）transition.visibility 已经在做的事，不需要嵌套调用重复做一遍
//
// Fix 4（本轮 cleanup sweep）：这个重入守卫之所以安全，依赖一条没有写在任何类型里的不变量——
// diffPetState（desktopPresence.ts）的 skipMoveBecauseHiding 让 `visibility === 'hide'` 与
// `move !== null` 在同一次求值里互斥（hide() 是这四个中断监听器里唯一能触发这条重入路径的
// 一个，见上一段），因此重入的那次 recompute 永远不会跟外层帧里一个 stale 的非 null
// transition.move 打架。这条互斥性本身由 electron/main/desktopPresence.test.ts 里
// "diffPetState — hide and move are mutually exclusive (Fix 4, reentrancy guard invariant)"
// 那个用例直接钉住（穷举输入空间断言，不是靠这里的注释口头担保）——若 diffPetState 将来被
// 改成允许 hide 与非 null move 同时出现，先破坏的会是那个测试，不是这里的静默假设
let applyingPetVisibility = false

function applyPetVisibility(overlayWindow: BrowserWindow, visibility: 'show' | 'hide' | null): void {
  if (applyingPetVisibility) return
  applyingPetVisibility = true
  try {
    if (visibility === 'show') overlayWindow.showInactive()
    else if (visibility === 'hide') overlayWindow.hide()
  } finally {
    applyingPetVisibility = false
  }
}

// Pet（悬浮窗）常驻桌面，是否被 blocker 挡住跟聊天窗口此刻是不是"当前展示方"无关，因此
// 无条件对 overlayWindow 求值，不像 Chat 那样有 chatPinMode/可见性门槛——这跟旧版本
// handleOverlayDodge 独立于 handlePinMode 运行是同一个既有约定，没有变化
//
// Resolver / Controller 边界修正（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"Resolver /
// Controller 边界：执行锁不是决策锁（阶段④ 修正）"）：本函数现在严格分两段——
//   ① Resolver：读 Desktop Context，求出 desired，无条件写入 latestPetDesired，永远不因为
//     programmaticMoveInFlight/重入而跳过。
//   ② Controller：应用 visibility（fail-safe，不受 in-flight 约束）；若 displayId 尚未落定，
//     只启动一次 relocate 并返回（geometry rule：EDGE 相关的收敛留给 relocate 落定之后的
//     下一次调用）；否则把 EDGE 维度的收敛交给 runPetEdgeController。
//
// 第 8 条 sweep 发现的重入场景：overlayWindow.hide()/showInactive() 可能同步触发一个更早
// 调用留下的、仍在飞的动画的中断（win.once('hide', ...) -> onInterrupt -> snap() ->
// onComplete -> onSettled -> 嵌套地再次调用本函数），发生在本函数还没跑完（正卡在下面调用
// hide()/showInactive() 那一行）的时候。applyPetVisibility 自己的重入守卫（见其定义处注释）
// 让这类嵌套调用只做上面①已经做过的事（刷新 latestPetDesired）就返回，不重复调用
// hide()/showInactive()——真正的收敛由这次仍在执行的外层调用，在它自己的 hide()/
// showInactive() 调用返回之后接着往下走完成。这与"结算之后若 latestDesired != applied 再
// 重新 apply"这条合法的收敛递归（moveToDisplay/runPetEdgeController 各自的 onSettled）不是
// 同一件事，不能用同一个守卫盖住——那条递归即使在测试里经常同步触发，也必须完整跑完，见
// applyPetVisibility 与 runPetEdgeController/settlePetPresence 各自定义处的说明
function evaluatePetPresence(overlayWindow: BrowserWindow | null, mainWindow: BrowserWindow | null): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  // 启动门控（electron/main/startupGate.ts）：DisplayStateMap 空白的这一小段窗口里不信任
  // preferredDisplayId，见该文件头注释与 index.ts 的接线
  if (!startupGateOpen) return

  // getPreferredDisplayId 只在用户真正拖动过时才非空（见 windowPositions.ts 该函数注释）。
  // 还没有任何偏好记录时的落点，必须跟 index.ts 里构造窗口时的启动落点算法完全一致——两者
  // 都调用同一个 resolveStartupDisplay（displays, preferredDisplayId），否则首次启动会出现
  // "窗口构造时落在 A，第一次 evaluate 却把它挪去 B"这种毫无意义的启动期跳屏
  const displays = screen.getAllDisplays()
  const preferredDisplayId = getEffectiveHomeDisplay(displays, 'overlay').id
  const allDisplayIds = displays.map(display => display.id)
  // Stage 3：resolver 决策树最前面的"交互中？"分支。isInteracting 目前唯一的来源是
  // isWindowDragInProgress('overlay')（electron/main/dragActivity.ts，Stage 3 起由
  // WM_ENTERSIZEMOVE/WM_EXITSIZEMOVE 权威信号驱动）——渲染层点击/主动交互进行中是本阶段之外
  // 的后续任务，接入时只需要把它们一并 OR 进这一个布尔值，resolvePetDesiredState 的签名不
  // 需要再变。
  // currentDisplayId 只在 isInteracting 为真时被 resolver 读取：appliedDisplayIdFor('overlay')
  // 是"上一次真正执行过移动的目标显示器"，还没有过（刚启动）时退回 preferredDisplayId——
  // 这与窗口构造时的落点算法一致（resolveOverlayStartupBounds 同样用 getEffectiveHomeDisplay），
  // 因此这个兜底值本身就是"这一刻窗口实际所在的显示器"
  //
  // Fix 1（second rework pass）：必须传 'overlay'，不是"任意窗口在拖"——TDD 把 ACTIVE 定义为
  // "用户正在直接与角色（悬浮窗）交互"，用户拖动聊天窗口不该让悬浮窗被判成 ACTIVE。见
  // electron/main/dragActivity.ts 头部注释里这条区分的完整推演
  const isInteracting = isWindowDragInProgress('overlay')
  const currentDisplayId = appliedDisplayIdFor('overlay') ?? preferredDisplayId
  // Stage 4：petAvoidanceEnabled 传给 resolver 而不是在这里另外分支处理——"先退出托管，再停止
  // 策略"这条恢复顺序完全由 resolvePetDesiredState 在 avoidanceEnabled=false 时返回
  // AMBIENT@home 来达成，下面的 diff/EDGE 收敛路径无需知道这个开关的存在，见该函数定义处注释
  const desired = resolvePetDesiredState(
    isInteracting,
    currentDisplayId,
    preferredDisplayId,
    getDisplayStateMap(),
    allDisplayIds,
    cachedConfig.petAvoidanceEnabled
  )

  // ① Resolver 收尾：无条件写入，从不因为下面任何 Controller 侧的状态跳过（"Resolver 不因为
  // 动画正在进行而停止思考"）
  latestPetDesired = desired

  // handleSuppressed 的前沿跟 latestPetDesired 走（intent），必须紧跟着 resolver 求值之后就
  // 尝试广播一次——不等 Controller 是否被 in-flight/重入挡住。这保证一个新的 EDGE 意图在一次
  // relocate 仍在飞的期间到达时，安全门立即 fail-closed 生效，即使 bounds 收敛本身要等到那次
  // relocate 落定才发生（见 currentPetPresencePayload/computeHandleSuppressed 定义处注释）
  maybeBroadcastPetPresence(overlayWindow)

  // ② Controller：visibility 永远立即应用，不受 programmaticMoveInFlight 约束——隐藏/显示
  // 没有"进行中"这个概念（不是动画），也没有理由因为一个仍在飞的 bounds 动画而推迟
  const chatFocused = mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isFocused()
  // Fix C：读 appliedDisplayIdFor('overlay') 而不是直接读 appliedPetDisplayId——一块承载着
  // 悬浮窗的显示器被拔掉时，appliedDisplayIdFor 会发现记录的 id 已经不在
  // screen.getAllDisplays() 里、把它当场清空，diff 因此看到 null（等同"从未 apply 过"），
  // 不会把一个指向不存在显示器的 id 带进这里
  const transition = diffPetState(desired, appliedDisplayIdFor('overlay'), overlayWindow.isVisible(), chatFocused)
  applyPetVisibility(overlayWindow, transition.visibility)

  // 置顶态由 Controller 应用，和 visibility 一样不受 in-flight 约束。必须走 applyAlwaysOnTop
  // 才能拿到 PIN_LEVEL——BrowserWindow 构造参数里的 alwaysOnTop 不接受 level，等价于
  // 'floating'，压不住全屏应用（见 PIN_LEVEL 定义处的分析）
  applyAlwaysOnTop(overlayWindow, 'overlay', desired.alwaysOnTop)

  // Fix 2（ts-backend-reviewer/integration-reviewer rework）：不要在用户正物理拖拽这个窗口
  // 的时候执行一次自动 relocate——理由与既有实现一致，见 diffPetState 里 skipMoveBecauseHiding
  // 分支同款的"错误更新 applied 会制造假象"论证。Fix 6（second rework pass）：这条守卫还兜着
  // "ACTIVE 分支的 currentDisplayId 因显示器拔出而回退到 home，产生一次不该发生的 move"这个
  // 场景，见 desktopPresence.test.ts 里 Fix 6 那条纯函数测试与本文件同名 describe 的整合测试
  if (transition.move !== null && !isInteracting) {
    // 顺序很重要：appliedPetDisplayId 必须在调用 moveToDisplay 之前更新——onSettled 一旦
    // 触发（哪怕是罕见地在同一个调用栈内同步触发），里面重新跑的 evaluatePetPresence 必须
    // 已经能看到"这次 relocate 的目标就是当前 applied 位置"，否则会对着同一个 stale 值再算
    // 出一次相同的 move、再调一次 moveToDisplay，无限递归下去
    appliedPetDisplayId = transition.move
    // geometry rule（TDD 原文，逐字引用）："依赖最终窗口几何的后续 transition，不在前一个
    // programmatic move settle 前执行"——因此这次调用到此为止，不再往下走到
    // runPetEdgeController：displayId 还没落定，任何贴边坐标计算此刻都会读到 stale 几何。
    // onSettled 是这次 relocate 真正落定之后重新走一遍本函数的入口，届时 transition.move
    // 会因为 appliedPetDisplayId 已经匹配而为 null，自然继续往下走到 EDGE 维度的收敛
    moveToDisplay(overlayWindow, 'overlay', transition.move, () => evaluatePetPresence(overlayWindow, mainWindow))
    return
  }

  // displayId 已经落定（或本来就不需要 move）——EDGE 维度的收敛可以安全地读取真实几何
  runPetEdgeController(overlayWindow, mainWindow, desired, isInteracting)
}

// Chat（聊天窗口）：只有 chatPinMode === 'smart' 时才交给 resolver 决策，'off'/'always' 两个
// 模式维持旧有的简单语义（前者永不置顶，后者恒定置顶，都不做 relocate/suppress）——这是这次
// 改动里唯一保留的 chatPinMode 分支结构，理由：'smart'（Stage 4 之前叫 'dodge-fullscreen'，
// 见 docs/MintBot_TDD.md "配置模型拆分"一节的改名说明）正是 §3.7 这一整节要替换的旧「检测到
// 全屏 → 跳屏/单屏隐藏」机制的挂载点，其余两个模式是与"要不要避让"完全正交的用户偏好。
//
// 只有窗口可见（用户主动打开）或者上一次是被本文件自己 SUPPRESSED（need to keep resolving
// so it can recover）时才继续；已最小化的窗口跳过——这三条判断取代了旧版本"只在可见且未
// 最小化时才处理"的门槛，多出来的 SUPPRESSED 例外是 Stage 2 的新增需求：SUPPRESSED 现在会
// 真正 hide() 窗口（旧版本的 dodge-fullscreen 从不隐藏聊天窗口，只切换置顶态），如果仍然
// 套用旧门槛，一旦被 SUPPRESSED，isVisible() 变 false，下一次 evaluate 会被门槛拦住，
// SUPPRESSED 就再也没有机会被重新评估、永远恢复不了。appliedChatPresence 只在本文件自己
// 因为 resolver 判定 SUPPRESSED 时才会被设成 'SUPPRESSED'，用户自己关闭/最小化窗口不会
// 触碰这个字段，因此不会把"用户主动关闭"误判成"应该继续评估"
function evaluateChatPresence(mainWindow: BrowserWindow | null): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) return
  if (!mainWindow.isVisible() && appliedChatPresence !== 'SUPPRESSED') return

  const { chatPinMode } = cachedConfig

  if (chatPinMode !== 'smart') {
    // 离开 resolver 管辖的模式：如果上一次是被本文件 SUPPRESSED 过，必须先恢复可见——
    // 'off'/'always' 从不隐藏窗口，不能让用户切走 'smart' 模式后聊天窗口仍然卡在隐藏状态。
    // showInactive()（不是 show()/focus()）跟其它 resolver 驱动的显示用同一个原语，理由同
    // diffChatState 头注释：这里的显示不是用户这一刻的主动操作
    if (appliedChatPresence === 'SUPPRESSED') mainWindow.showInactive()
    applyAlwaysOnTop(mainWindow, 'chat', chatPinMode === 'always')
    appliedChatPresence = null
    appliedChatDisplayId = null
    return
  }

  // 同 evaluatePetPresence：落点算法必须跟 index.ts 构造聊天窗口时用的 resolveStartupDisplay
  // 完全一致，见该函数内注释
  const displays = screen.getAllDisplays()
  const preferredDisplayId = getEffectiveHomeDisplay(displays, 'chat').id
  const allDisplayIds = displays.map(display => display.id)
  const desired = resolveChatDesiredState(preferredDisplayId, getDisplayStateMap(), allDisplayIds)
  // Fix C：同上，读 appliedDisplayIdFor('chat') 而不是直接读 appliedChatDisplayId
  const transition = diffChatState(desired, appliedDisplayIdFor('chat'), mainWindow.isVisible())

  // Fix 2：同 evaluatePetPresence 的这条守卫，理由见该函数内同名判断上方的注释——不要在
  // 用户拖拽这个窗口期间执行自动 relocate，只跳过 move，不影响下面的 alwaysOnTop/visibility
  // 副作用。Stage 3 起 isWindowDragInProgress('chat') 由 WM_ENTERSIZEMOVE/WM_EXITSIZEMOVE
  // 权威信号驱动，evaluatePetPresence 那条曾经的"没有关闭的窄口"已经随之关闭，这里同理受益。
  // Fix 1（second rework pass）：必须传 'chat'，不是"任意窗口在拖"——同 evaluatePetPresence，
  // 用户拖动悬浮窗不该压住聊天窗口本该发生的自动 relocate
  if (transition.move !== null && !isWindowDragInProgress('chat')) {
    moveToDisplay(mainWindow, 'chat', transition.move)
    appliedChatDisplayId = transition.move
  }
  // 无条件调用——幂等短路交给 applyAlwaysOnTop 自己的 lastAppliedOnTop 缓存，见该函数注释。
  // 这保证"desired 没变则零 API 调用"这条要求在置顶态这一侧同样成立，不需要 diffChatState
  // 额外算一次"要不要调用"
  applyAlwaysOnTop(mainWindow, 'chat', transition.alwaysOnTop)
  // 绝不能用 show()/focus()：TDD 明确要求"前台应用的变化不得主动 show()/focus() 聊天窗口"，
  // showInactive() 恢复可见但不抢焦点，是这条约束在这里唯一允许的原语
  if (transition.visibility === 'show') mainWindow.showInactive()
  else if (transition.visibility === 'hide') mainWindow.hide()

  appliedChatPresence = desired.presence
}

export function evaluateDesktopPresence(mainWindow: BrowserWindow | null, overlayWindow: BrowserWindow | null): void {
  evaluatePetPresence(overlayWindow, mainWindow)
  evaluateChatPresence(mainWindow)
}
