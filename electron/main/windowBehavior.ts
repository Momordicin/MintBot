import { BrowserWindow, screen } from 'electron'
import type { ActiveWindowInfo } from './activeWindowMonitor'
import { animateTo, isAnimating } from './windowAnimation'
import { getPreferredBounds, setPreferredBounds, computeDefaultBoundsForDisplay } from './windowPositions'
import type { Bounds, WindowKey } from './windowPositions'

// 悬浮窗行为策略的实际置顶/躲避逻辑（buzzing-frolicking-eich.md 计划子任务③，依赖子任务①
// 的配置层/托盘骨架 + 子任务②的 activeWindowMonitor 扩展，均已合入）。从 index.ts 独立成
// 文件，理由跟 activeWindowMonitor.ts 独立成文件一样：这块逻辑体量不小，index.ts 已经 340+ 行

// 主进程本地类型：跟 index.ts 里 CORE_URL/PinMode/WindowBehaviorConfig 同样的独立定义约定
// （主进程只通过 HTTP 与核心服务交互，不反向导入 services/core/config/index.ts），
// 两个主进程文件各自维护一份而不是互相 import，避免这两个本就该各自独立的模块产生耦合
type PinMode = 'off' | 'dodge-fullscreen' | 'always-on-top'

interface WindowBehaviorConfig {
  pinMode: PinMode
  fullscreenWhitelist: string[]
  blacklist: string[]
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
// 停止重抬，晚出现的浮层天然在上，不需要额外的检测逻辑。
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
let lastAppliedOnTop: boolean | null = null

function applyAlwaysOnTop(win: BrowserWindow, onTop: boolean): void {
  if (lastAppliedOnTop === onTop) return
  win.setAlwaysOnTop(onTop, PIN_LEVEL)
  lastAppliedOnTop = onTop
}

const DEFAULT_CONFIG: WindowBehaviorConfig = {
  pinMode: 'off',
  fullscreenWhitelist: [],
  blacklist: [],
}

// 内存缓存：启动时 initWindowBehaviorConfig() 拉一次，之后由 index.ts 的 SSE 订阅在收到
// window-behavior-changed 帧时通过 updateCachedWindowBehaviorConfig() 替换。取不到/还没
// 初始化完成之前用默认值兜底，不阻塞 handleActiveWindowChange 的其它逻辑
let cachedConfig: WindowBehaviorConfig = DEFAULT_CONFIG

export async function initWindowBehaviorConfig(): Promise<void> {
  try {
    const response = await fetch(`${CORE_URL}/config/window-behavior`)
    if (!response.ok) return
    cachedConfig = await response.json()
  } catch (err) {
    console.error('[WindowBehavior] Failed to fetch initial config, using defaults:', err)
  }
}

// 由 index.ts 的 SSE 订阅在收到 window-behavior-changed 帧时调用，直接替换整份缓存——
// 广播的 payload 就是服务端已经校验+合并过的完整 WindowBehaviorConfig（见
// services/core/routes/windowBehavior.ts），这里不需要再做一次字段校验。
//
// 这个"payload 恒完整"的前提由 services/core/config/index.ts 的 updateWindowBehaviorConfig()
// 保证：它必须以 getWindowBehaviorConfig()（已经过 mergeWindowBehaviorConfig 补齐默认值的
// 当前配置）而非磁盘原始 section 作为合并起点。曾经用 readRawSection 作起点，配置文件里
// windowBehavior 段缺 fullscreenWhitelist/blacklist 时 PATCH 会把这两个字段整个丢掉，残缺
// 对象沿广播传到这里整份替换缓存，下面 includesIgnoreCase 的 list.some(...) 就对 undefined
// 调用而崩主进程。两个进程各自维护一份 WindowBehaviorConfig 类型、不共享 shared/types，
// 主进程这侧没有任何编译期信号能感知服务端是否又出现绕开该合并逻辑的新写入路径——
// 改动 updateWindowBehaviorConfig 或给 windowBehavior 新增写入通道时，需要重新核对这条假设。
//
// mainWindow 传入是为了立刻处理"切走 dodge-fullscreen 模式时聊天窗口正卡在跳屏位置"这个
// 归位需求——不能指望 handlePinMode 的同款守卫逻辑靠 activeWindowMonitor 的下一次轮询来
// 触发：用户改这个设置的方式通常是打开设置页/托盘菜单，这一刻前台窗口就是 MintBot 自己，
// activeWindowMonitor 会因为自我排除直接返回 null，handleActiveWindowChange 整个短路，
// handlePinMode 根本不会被调用，归位会一直拖到用户下一次切到某个外部窗口才触发——
// 这里在配置真正改变的那一刻就直接做一次归位检查，不依赖轮询
export function updateCachedWindowBehaviorConfig(config: WindowBehaviorConfig, mainWindow: BrowserWindow | null): void {
  cachedConfig = config
  if (mainWindow) {
    restoreHomeBoundsIfLeavingDodgeMode(mainWindow, config.pinMode)
    // P-3：配置变更这一刻立即把置顶态套用到新模式，不等下一次轮询——不然从设置页/托盘
    // 切完模式后，置顶态要拖到用户下一次切到外部窗口、handlePinMode 被轮询驱动调用时
    // 才补上（见上面 restoreHomeBoundsIfLeavingDodgeMode 的调用点注释）。
    // 'off' → false，'always-on-top' → true，'dodge-fullscreen' → true（P-2：非冲突态基线
    // 已改为常驻置顶）。三种模式恰好用 pinMode !== 'off' 一个表达式覆盖。
    //
    // 但 dodge-fullscreen 且 dodgeDisplayId !== null 时必须跳过：那表示轮询已经判定当前存在
    // 全屏冲突并做过处置，其中"跳不出去只能让位"这一支会特意把置顶设成 false。触发这次
    // 调用时前台确实是 MintBot 自己，但那只说明"这一瞬间没有冲突"，不代表那个让位决定
    // 已经失效——用户可能只是 Alt-Tab 过来改了个跟 pinMode 无关的字段（如黑名单），
    // 服务端广播的却是合并后的完整配置。此时无条件置顶会把窗口顶到全屏应用之上，
    // 直到下一次轮询才自我纠正。冲突态下的置顶归轮询驱动的 handlePinMode 独占管理
    if (config.pinMode !== 'dodge-fullscreen' || dodgeDisplayId === null) {
      applyAlwaysOnTop(mainWindow, config.pinMode !== 'off')
    }
  }
}

// 大小写不敏感匹配：Windows 文件名本身不区分大小写，QueryFullProcessImageNameW 实际返回的
// 大小写不保证跟用户通过设置页文件选择框选中时存下来的大小写一致（同 activeWindowMonitor.ts
// 自身排除 MintBot 窗口时已经踩过的同一个坑）——按区分大小写比较会导致白名单/黑名单规则
// 静默永远不命中，比检测不到全屏更隐蔽
function includesIgnoreCase(list: string[], name: string): boolean {
  const lower = name.toLowerCase()
  return list.some(item => item.toLowerCase() === lower)
}

// 程序自己上一次调用 animateTo 的时间戳（moveToNonFullscreenDisplay / restoreToDisplay
// 各自更新），供 handleWindowMoved 判断某次 'moved' 事件是不是程序自己刚移动完的余波
// （见该函数注释）
let lastProgrammaticMoveAt = 0

// 共用工具函数：把 win 挪到 excludeDisplayId 之外的某块显示器上——查表拿该显示器的
// 偏好位置/尺寸（getPreferredBounds），查到就直接用；查不到（这块显示器第一次出现）就用
// computeDefaultBoundsForDisplay 算一次默认值、立刻存表，再用。找不到替代显示器（单屏，
// 或所有屏幕都被排除）时返回 false，由调用方决定接下来怎么处理（隐藏悬浮窗 / 聊天窗口
// 原地不动）。
//
// 这是问题1（buzzing-frolicking-eich.md）的核心修复：不再让跳屏目标"临时算出来"——旧版本
// 即便已经把 size 参数固定成调用方传入的基准尺寸，只要目标位置仍然是"现算"的，Windows
// 异步的 DPI 换算纠正（WM_DPICHANGED，windowAnimation.ts 注释里记录过）就有机会把一次性的
// 几像素误差喂回下一轮，跨屏往返越多次、累积越多（electron#27651 的另一种表现形式：实机
// 诊断过聊天窗口 256×476 → 260×479、悬浮窗 223×225 → 225×226 均为单调增长）。现在跳屏
// 目标恒定来自查表，查到的值不管跳多少次、跳多快都不变，反馈环被彻底切断。
//
// baseline/baselineDisplay 只在"这块目标显示器第一次出现、查表落空"时才会被
// computeDefaultBoundsForDisplay 用到——调用方应传入"进入这次跳屏之前，窗口在原本那块
// 屏幕上静止时的真实尺寸/所在显示器"（一次真实的、非跳屏产物的现场读数），不是上一次
// setBounds 的回读值。
//
// 跳屏动画：走 animateTo 而不是直接 setBounds，悬浮窗和聊天窗口共用这个函数，因此两者的
// 跳屏都会带上划出/飞入动画（同屏/尺寸变化会被 animateTo 内部的前置守卫短路成瞬间跳）。
// 这里不使用 animateTo 返回的取消函数——中断处理（最小化/隐藏/关闭/销毁）已经由
// windowAnimation.ts 内部的一次性监听自行兜底，调用方不需要持有它
export function moveToNonFullscreenDisplay(
  win: BrowserWindow,
  windowKey: WindowKey,
  excludeDisplayId: number,
  baseline: Bounds,
  baselineDisplay: Electron.Display
): boolean {
  const target = screen.getAllDisplays().find(display => display.id !== excludeDisplayId)
  if (!target) return false

  let bounds = getPreferredBounds(windowKey, target.id)
  if (!bounds) {
    bounds = computeDefaultBoundsForDisplay(target, baseline, baselineDisplay)
    setPreferredBounds(windowKey, target.id, bounds)
  }

  lastProgrammaticMoveAt = Date.now()
  animateTo(win, bounds)
  return true
}

// 归位（"跳回原来那块屏幕"）用的也是同一套查表逻辑：目标显示器换成"进入躲避前所在的
// 那块屏幕"，查到偏好位置就直接用。查不到时理论上不应该发生——handleOverlayDodge/
// handlePinMode 进入躲避的那一刻已经会主动把家这块显示器的偏好记录补上（见两处调用点
// 注释），这里只是一道兜底安全网。homeDisplay 本身已经从当前连接的显示器里消失（比如
// 被拔掉）时不归位，原地不动——没有目标显示器的 workArea 可用，没法算出任何有意义的落点。
//
// ⚠️ 兜底分支的 baseline/baselineDisplay 必须现读"窗口此刻实际所在的显示器"（调用这个
// 函数时窗口还没挪动，仍然停在跳屏目的地上），不能像最初实现那样直接传 homeDisplay 自己
// 当 baselineDisplay——那样会把缩放比例差强制算成 0，把"跳屏目的地缩放过的尺寸"原样存成
// 家这块屏幕的永久偏好，在缩放比例不同的双屏环境下第一次归位就把窗口尺寸永久搞错（且没有
// 自愈机制，一直错到用户手动拖动为止）——这正是 review 抓到的 bug
function restoreToDisplay(win: BrowserWindow, windowKey: WindowKey, homeDisplayId: number): void {
  const homeDisplay = screen.getAllDisplays().find(display => display.id === homeDisplayId)
  if (!homeDisplay) return

  let bounds = getPreferredBounds(windowKey, homeDisplayId)
  if (!bounds) {
    const currentBounds = win.getBounds()
    const currentDisplay = screen.getDisplayMatching(currentBounds)
    bounds = computeDefaultBoundsForDisplay(homeDisplay, currentBounds, currentDisplay)
    setPreferredBounds(windowKey, homeDisplayId, bounds)
  }

  lastProgrammaticMoveAt = Date.now()
  animateTo(win, bounds)
}

// 'moved' 监听回调（index.ts 在创建 mainWindow/overlayWindow 时各自注册一次）：命中即认定
// 用户真实拖动了窗口，把拖动后的位置/所在显示器写回偏好表——查表设计下这是表里数据"随时间
// 更新"的唯一渠道（跳屏本身只读表，不写表，除了首次在某块显示器出现时的一次性默认值）。
//
// 需要排除两类"不是用户拖动"的触发：① 动画进行中（isAnimating()）——leg1/leg2 补间过程中
// 每一帧都调用 setBounds，会连续触发 'moved'；② 程序刚调用完 animateTo 的冷却期内（不足
// 1 秒）——动画结束那一刻的最终 setBounds 与后续可能出现的异步 WM_DPICHANGED 纠正都可能
// 再触发一次 'moved'，冷却期把这些程序自己的动作也滤掉。悬浮窗当前 resizable: false 且
// 没有暴露拖动交互，这个监听器对它而言目前是"装着但触发不到"——以后如果悬浮窗支持拖动，
// 直接生效，不需要再改这部分
export function handleWindowMoved(windowKey: WindowKey, win: BrowserWindow): void {
  if (isAnimating() || Date.now() - lastProgrammaticMoveAt < 1000) return
  const bounds = win.getBounds()
  const displayId = screen.getDisplayMatching(bounds).id
  setPreferredBounds(windowKey, displayId, bounds)
}

// 悬浮窗躲避状态：只保留"进入躲避状态那一刻，悬浮窗当时所在的显示器 id"这一个整数，不再
// 额外维护一份捕获的坐标（旧版本的 overlayHomeBounds）——查表设计下，跳屏目标与归位目标
// 都改由 moveToNonFullscreenDisplay/restoreToDisplay 现查 windowPositions.ts 的持久化表，
// 不需要在内存里另存一份"某一刻捕获的坐标"，也就没有它可能过期/漂移的问题。
//
// 之后每个 tick 只要仍需要躲避就复用这同一个 id 作为 moveToNonFullscreenDisplay 的排除项，
// 不要每次都用悬浮窗"当前"所在显示器重新计算——悬浮窗已经跳到别的屏幕之后，"当前所在
// 显示器"会变成刚跳过去的那块屏幕，若以它作排除项，双屏环境下会在两块屏幕之间每 500ms
// 来回反复横跳（排除 B 找到 A，下一 tick 排除 A 又找回 B）
let overlayDodgeSourceDisplayId: number | null = null

// 悬浮窗躲避逻辑（chatIsHidden 时走这支）。activeWindowMonitor 只回传 isFullscreen/exeName/
// title/displayId，没有前台窗口的原始矩形，无法在这里反查它实际所在的显示器——按计划文档
// 的简化，直接尝试把悬浮窗移到"它自己当前所在显示器"之外的某块屏幕，不去追踪前台全屏窗口
// 本身在哪块屏幕
function handleOverlayDodge(info: ActiveWindowInfo, overlayWindow: BrowserWindow | null): void {
  if (!overlayWindow) return

  // 上一轮跳屏/归位动画还没结束时整体跳过这个 tick，不只是为了避免半路打断动画（那部分
  // 交给 animateTo 自己的取消/重开逻辑处理，本来就是安全的）——更重要的是下面
  // overlayDodgeSourceDisplayId === null 那次性的"补种家的偏好记录"必须读到窗口真正静止
  // 时的坐标，动画进行中读 getBounds() 可能读到半路的位置，把 screen.getDisplayMatching
  // 判断成错误的显示器，进而把这块屏幕的偏好记录永久写坏（review 抓到的同类风险）。
  // isAnimating() 是 windowAnimation.ts 模块级单飞状态，跟聊天窗口共用（同一时刻只有一个
  // 窗口在动画中）。这里的守卫覆盖整个函数（含下面的归位分支），比 handlePinMode 只把
  // 守卫放在冲突分支里更宽——意味着聊天窗口那边的动画在跑时，悬浮窗的归位也会被这个
  // tick 一起跳过、顺延到下一 tick 才重新判断，最多多等约 500ms，不会导致状态卡死或
  // 数据错误，只是刻意选择了更保守、不需要按分支精细拆分的写法
  if (isAnimating()) return

  // 黑名单单独也算"必须躲避"（不要求同时全屏）：黑名单的语义是"这个程序不全屏也不能被
  // 悬浮窗盖住"，跟全屏走同一个分支
  const needsToDodge = info.isFullscreen || (info.exeName !== null && includesIgnoreCase(cachedConfig.blacklist, info.exeName))
  const isWhitelisted = info.exeName !== null && includesIgnoreCase(cachedConfig.fullscreenWhitelist, info.exeName)

  if (needsToDodge && !isWhitelisted) {
    if (overlayDodgeSourceDisplayId === null) {
      const homeBounds = overlayWindow.getBounds()
      const homeDisplay = screen.getDisplayMatching(homeBounds)
      overlayDodgeSourceDisplayId = homeDisplay.id
      // 进入躲避的这一刻，悬浮窗还在家、完全没被跳屏影响过，是本次躲避会话里唯一一次
      // "真正静止"的读数——如果家这块显示器还没有偏好记录，只有现在是安全的时机把它
      // 存进表里。等到之后归位时才现读（restoreToDisplay 的兜底分支），读到的会是刚从
      // 目标显示器跳回来之后的状态（可能是按目标显示器缩放过的尺寸），不是家本身的真实
      // 尺寸——那正是 review 抓到的 bug，这里在源头补上，让 restoreToDisplay 的兜底分支
      // 退化成一个理论上不会命中的安全网，而不是实际生效的主路径
      if (!getPreferredBounds('overlay', overlayDodgeSourceDisplayId)) {
        setPreferredBounds('overlay', overlayDodgeSourceDisplayId, homeBounds)
      }
    }
    // baseline 只在跳屏目标显示器第一次出现、查表落空时才会被用到（见
    // moveToNonFullscreenDisplay 注释）；这里现读一次悬浮窗当前实际尺寸/所在显示器即可，
    // 是否"当前"就是刚跳过去的位置不影响正确性——已经查到表项的 tick 里这两个值根本不会
    // 被用上
    const baseline = overlayWindow.getBounds()
    const baselineDisplay = screen.getDisplayMatching(baseline)
    const moved = moveToNonFullscreenDisplay(overlayWindow, 'overlay', overlayDodgeSourceDisplayId, baseline, baselineDisplay)
    if (moved) {
      overlayWindow.showInactive()
    } else {
      // 没有别的屏幕可跳（单屏，或全部屏幕都是同一块）：直接隐藏，不能留在原地盖住全屏/
      // 黑名单程序
      overlayWindow.hide()
    }
  } else {
    // 问题1b：只有前台窗口确实落在"家"（进入躲避前所在）那块屏幕上，才认定冲突解除、可以
    // 归位——否则保持当前已经躲避到的位置不变（既不归位，也不重新计算新的跳屏目标：已经
    // 在一个安全的地方了，对"家"那块屏幕现状没有任何新信息之前不需要动）
    if (overlayDodgeSourceDisplayId !== null && info.displayId === overlayDodgeSourceDisplayId) {
      restoreToDisplay(overlayWindow, 'overlay', overlayDodgeSourceDisplayId)
      overlayDodgeSourceDisplayId = null
    }
    // 已核实 showInactive 走 ShowWindow(SW_SHOWNOACTIVATE)，不像 setAlwaysOnTop 那样必然
    // 带一次 SetWindowPos；但 ShowWindow 对"已经可见"的窗口是否触碰 z-order 微软文档未
    // 定义，不能假设它是安全的 no-op。这里每次 onChange 只要判定不需要躲避就会走到这一行，
    // 500ms 轮询下同样有反复重复调用的风险，加可见性守卫让已显示时成为彻底的 no-op——
    // dodge 分支里 hide() 之后 isVisible() 为 false，守卫照常放行，无回归。
    //
    // 上面 moved 分支的 showInactive() 没有加同款守卫，这个不对称是刻意的、不是遗漏：
    // 那一支每 tick 都会先无条件跑一次 moveToNonFullscreenDisplay() → setBounds()，
    // setBounds 本身就是个更大的重复调用源（且尚未做"位置未变则跳过"的幂等化），
    // 只给它的 showInactive 加守卫遮不住 setBounds，收益接近零。真要收敛那一支，
    // 该做的是给 moveToNonFullscreenDisplay 加位置幂等判断，那是另一件事
    if (!overlayWindow.isVisible()) {
      overlayWindow.showInactive()
    }
  }
}

// 聊天窗口置顶逻辑的"冲突态"记录：只保留 dodgeDisplayId——进入冲突那一刻聊天窗口所在的
// 显示器 id（视为被全屏应用占用的屏幕）。不再额外维护一份捕获的坐标（旧版本的
// homeBounds），理由跟 overlayDodgeSourceDisplayId 同（查表设计下跳屏/归位目标都改由
// moveToNonFullscreenDisplay/restoreToDisplay 现查持久化表）。同样避免每个 tick 都用
// 聊天窗口"当前"所在显示器重新计算排除项，导致双屏来回横跳
let dodgeDisplayId: number | null = null

// 切换到非 dodge-fullscreen 模式时，如果聊天窗口当下正卡在跳屏后的位置（dodgeDisplayId
// 有值），必须先归位——否则用户在跳屏躲避期间把置顶模式切成"关闭"或"绝对置顶"，窗口会
// 永久留在跳过去的那块屏幕的角落里，dodgeDisplayId 也会变成没人再清理的孤儿状态。
//
// 两个调用点：① handlePinMode 每个 tick 都会经过这里（覆盖"轮询过程中前台窗口切换、
// 顺带发现 pinMode 也变了"这种情况）；② updateCachedWindowBehaviorConfig 在配置真正
// 改变的那一刻立即调用一次——这一条是必须的，不能只依赖①：用户改这个设置通常是在设置页/
// 托盘菜单里操作，那一刻前台窗口就是 MintBot 自己，activeWindowMonitor 会因为自我排除
// 返回 null，handleActiveWindowChange 整个短路，handlePinMode 根本不会被调用，若只有①，
// 归位会一直拖到用户下一次切到某个外部窗口才触发
function restoreHomeBoundsIfLeavingDodgeMode(mainWindow: BrowserWindow, pinMode: PinMode): void {
  if (pinMode !== 'dodge-fullscreen' && dodgeDisplayId !== null) {
    restoreToDisplay(mainWindow, 'chat', dodgeDisplayId)
    // 归位的同时要把置顶态也校正到新模式该有的样子——这个函数现在有两个调用点：
    // handlePinMode 里紧跟着的 'off'/'always-on-top' 分支会自己调 setAlwaysOnTop，
    // 但 updateCachedWindowBehaviorConfig 是独立调用，没有后续分支兜底，不在这里
    // 一并处理的话，跳屏期间已经生效的 setAlwaysOnTop(true) 会一直卡住，直到下一次
    // 切到外部窗口触发轮询路径才被动更正——走 applyAlwaysOnTop 本身就是幂等的，不影响
    // handlePinMode 那边紧接着再调一次
    applyAlwaysOnTop(mainWindow, pinMode === 'always-on-top')
    dodgeDisplayId = null
  }
}

// 按当前 pinMode 套用置顶态。全部 setAlwaysOnTop 调用都走 applyAlwaysOnTop（见上方定义），
// 幂等短路交给它处理，这里只负责算出每个分支该有的目标态是什么。
//
// 之前这里还有一条"条件让位"规则（isTopmost && !isFullscreen 时本 tick 跳过重抬），是
// 幂等置顶引入前用来缓解同一个问题（轮询重抬盖住系统浮层）的局部补丁，现已整套移除——
// 幂等置顶从根上解决了"重抬"这个动作本身，不再需要按前台窗口是否 topmost 做例外判断。
// 全屏时也不再有额外的强制重抬例外分支：是否压过全屏应用完全交给下面 dodge-fullscreen
// 分支自己的白名单/跳屏/让位逻辑决定，'always-on-top' 模式下没有特殊处理
function handlePinMode(info: ActiveWindowInfo, mainWindow: BrowserWindow): void {
  const { pinMode, fullscreenWhitelist } = cachedConfig

  restoreHomeBoundsIfLeavingDodgeMode(mainWindow, pinMode)

  if (pinMode === 'off') {
    applyAlwaysOnTop(mainWindow, false)
    return
  }

  if (pinMode === 'always-on-top') {
    applyAlwaysOnTop(mainWindow, true)
    return
  }

  // pinMode === 'dodge-fullscreen'
  //
  // 简化说明（计划文档描述的是理想版本，这里是这份数据能支持的最简近似）：判断"是否存在
  // 冲突"只用 info.isFullscreen && 不在白名单里，不再额外核对该全屏窗口是否与聊天窗口
  // 处于同一块显示器——activeWindowMonitor 只回传 isFullscreen/exeName/title，没有前台
  // 窗口的原始矩形，这里没法反查它具体在哪块显示器。单一前台窗口的常见场景下（同一时刻
  // 只有一个前台全屏应用），这个简化不会造成"聊天窗口在没有任何屏幕冲突的情况下也被
  // 跳屏"之外的可观测差异
  const isWhitelisted = info.exeName !== null && includesIgnoreCase(fullscreenWhitelist, info.exeName)
  const inContention = info.isFullscreen && !isWhitelisted

  if (inContention) {
    // 轮询每 500ms tick 一次，进入冲突后只要仍在冲突就会一直落到这个分支。这个判断必须
    // 放在整个分支最前面，早于下面 dodgeDisplayId === null 的"补种家的偏好记录"——那段
    // 逻辑需要读窗口此刻的真实静止坐标，如果上一轮跳屏/归位动画还没跑完就先判断了它，
    // 读到的会是动画半路的位置，可能被 screen.getDisplayMatching 误判成错误的显示器，
    // 把这块屏幕的偏好记录永久写坏（review 抓到的同类风险，跟 handleOverlayDodge 同样
    // 处理）。跳屏动画本身约 360ms，通常在下一次 tick 前就已经跑完，但不能保证：若不加
    // 这道抑制，动画途中再调 moveToNonFullscreenDisplay 也会拿"半路"的 getBounds() 当
    // 新起点重新起算一次动画，逐帧打断、可能来回抖动。跳过时不重复判断 moved/
    // applyAlwaysOnTop——上一次已经跑完的那次调用已经把置顶态设成了该有的样子，本 tick
    // 没有新信息，维持现状即可
    if (isAnimating()) return
    if (dodgeDisplayId === null) {
      const homeBounds = mainWindow.getBounds()
      const homeDisplay = screen.getDisplayMatching(homeBounds)
      dodgeDisplayId = homeDisplay.id
      // 进入冲突的这一刻，聊天窗口还在家、完全没被跳屏影响过——跟 handleOverlayDodge
      // 同样的理由，只有现在才是安全时机把家这块显示器的偏好记录补上（如果还没有的话），
      // 让 restoreToDisplay 的兜底分支在实践中几乎不会被真正用到
      if (!getPreferredBounds('chat', dodgeDisplayId)) {
        setPreferredBounds('chat', dodgeDisplayId, homeBounds)
      }
    }
    // baseline 只在跳屏目标显示器第一次出现、查表落空时才会被用到，见
    // moveToNonFullscreenDisplay 注释
    const baseline = mainWindow.getBounds()
    const baselineDisplay = screen.getDisplayMatching(baseline)
    const moved = moveToNonFullscreenDisplay(mainWindow, 'chat', dodgeDisplayId, baseline, baselineDisplay)
    // P-2：dodge-fullscreen 的语义改为"常驻置顶 + 遇全屏跳屏"。跳成功后聊天窗口已经不
    // 跟全屏应用共享同一块屏幕，置顶不再构成遮挡，继续置顶才是用户预期的默认体验（等价
    // 于非冲突场景下的悬浮置顶）
    if (moved) {
      applyAlwaysOnTop(mainWindow, true)
    } else {
      // 单屏，或所有显示器都被 dodgeDisplayId 排除（找不到可跳的目标屏幕）：跳不出去，
      // 就没有"挪开位置来避免遮挡"这条路可走，dodge-fullscreen 的目的本来就是不遮挡
      // 全屏内容，跳屏只是首选手段，跳不了时唯一还能兑现这个目的的办法是让位——取消
      // 置顶，允许全屏应用（游戏/播放器）盖住聊天窗口，而不是死扛置顶。这里必须显式
      // 求值为 false 传给 applyAlwaysOnTop，不能不调用指望它维持原样：P-2 之后非冲突态
      // 的基线已经是"置顶"，进入这次冲突之前 alwaysOnTop 大概率已经是 true，不显式取消
      // 的话它会一直卡在 true 直到冲突解除才被下面 else if 分支纠正回来，等同于单屏下
      // 这个模式又退化回"从不让位"
      applyAlwaysOnTop(mainWindow, false)
    }
  } else if (dodgeDisplayId !== null) {
    // 问题1b：只有前台窗口确实落在"家"（进入冲突前所在）那块屏幕上，才认定冲突解除、可以
    // 归位——否则保持当前已经躲避到的位置不变，对"家"那块屏幕现状没有任何新信息之前不
    // 归位、也不重新计算新的跳屏目标
    if (info.displayId === dodgeDisplayId) {
      // 冲突解除：归位 + 恢复置顶（P-2：dodge-fullscreen 非冲突态的基线是置顶，不再是
      // 取消置顶）+ 清掉记录
      restoreToDisplay(mainWindow, 'chat', dodgeDisplayId)
      applyAlwaysOnTop(mainWindow, true)
      dodgeDisplayId = null
    }
  } else {
    // 从未冲突过：P-2 之后 dodge-fullscreen 平时的表现跟 always-on-top 一致——常驻置顶，
    // 区别只在遇到全屏冲突时会跳屏（跳不了时让位，见上面 inContention 分支）
    applyAlwaysOnTop(mainWindow, true)
  }
}

// activeWindowMonitor 的 onChange 回调，替换 index.ts 里原来的 console.log。mainWindow/
// overlayWindow 由调用方（index.ts）传入当前值——两个引用会随窗口创建/关闭重新赋值，
// 这里不持有自己的一份，避免脱节
export function handleActiveWindowChange(
  info: ActiveWindowInfo | null,
  mainWindow: BrowserWindow | null,
  overlayWindow: BrowserWindow | null
): void {
  // null 覆盖非 Windows / 检测失败 / 前台是 MintBot 自己三种情况（活跃窗口监听器内部已经
  // 排除了这些情况，这里不需要再判断一次），本 tick 两套逻辑都跳过
  if (info === null) return

  // 聊天窗口"不可见"（已最小化/隐藏/关闭）时悬浮窗是当前展示方，走躲避逻辑；否则聊天窗口
  // 是当前展示方，走置顶逻辑
  if (!mainWindow || !mainWindow.isVisible() || mainWindow.isMinimized()) {
    handleOverlayDodge(info, overlayWindow)
  } else {
    handlePinMode(info, mainWindow)
  }
}
