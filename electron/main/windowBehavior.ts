import { BrowserWindow, screen } from 'electron'
import type { ActiveWindowInfo } from './activeWindowMonitor'
import { animateTo, isAnimating } from './windowAnimation'

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
    // 但 dodge-fullscreen 且 homeBounds !== null 时必须跳过：那表示轮询已经判定当前存在
    // 全屏冲突并做过处置，其中"跳不出去只能让位"这一支会特意把置顶设成 false。触发这次
    // 调用时前台确实是 MintBot 自己，但那只说明"这一瞬间没有冲突"，不代表那个让位决定
    // 已经失效——用户可能只是 Alt-Tab 过来改了个跟 pinMode 无关的字段（如黑名单），
    // 服务端广播的却是合并后的完整配置。此时无条件置顶会把窗口顶到全屏应用之上，
    // 直到下一次轮询才自我纠正。冲突态下的置顶归轮询驱动的 handlePinMode 独占管理
    if (config.pinMode !== 'dodge-fullscreen' || homeBounds === null) {
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

// 共用工具函数：把 win 挪到 excludeDisplayId 之外的某块显示器的右下角。复用
// index.ts createOverlayWindow() 里贴右下角的坐标算法，但参数化成"目标显示器"+"目标尺寸"，
// 因为这个工具函数同时服务于悬浮窗和聊天窗口两种不同尺寸的窗口。找不到替代显示器（单屏，
// 或所有屏幕都被排除）时返回 false，由调用方决定接下来怎么处理（隐藏悬浮窗 / 聊天窗口
// 原地不动）。
//
// size 必须由调用方传入进入躲避前记录的基准尺寸（homeBounds/overlayHomeBounds），不能在
// 这里读 win.getBounds()——这正是 electron#27651 的反馈环模式：躲避期间每个 tick 都会
// 重新调用本函数，若尺寸取自 win.getBounds()，会把上一次 setBounds 的（可能已被 DIP 取整
// 带偏 1px 的）结果当成下一次的输入喂回 setBounds，逐 tick 累积增长（实机诊断：聊天窗口
// 256×476 → 260×479，悬浮窗 223×225 → 225×226，均为单调增长，与此模式吻合）。改成调用方
// 传入固定的基准尺寸后，跳屏目标尺寸在整个"跳出→归位"周期内恒定，不再有反馈环，
// 也不会再有累积增长
//
// 跳屏动画：走 animateTo 而不是直接 setBounds，悬浮窗和聊天窗口共用这个函数，因此两者的
// 跳屏都会带上划出/飞入动画（同屏/尺寸变化会被 animateTo 内部的前置守卫短路成瞬间跳）。
// 这里不使用 animateTo 返回的取消函数——中断处理（最小化/隐藏/关闭/销毁）已经由
// windowAnimation.ts 内部的一次性监听自行兜底，调用方不需要持有它
export function moveToNonFullscreenDisplay(
  win: BrowserWindow,
  excludeDisplayId: number,
  size: { width: number; height: number }
): boolean {
  const target = screen.getAllDisplays().find(display => display.id !== excludeDisplayId)
  if (!target) return false

  // 用 workArea（带 x/y 偏移）而不是 workAreaSize：任务栏停靠在上边/左边时 workArea.x/y
  // 不为 0，只用宽高算出来的坐标会跟任务栏厚度错位——跟 createOverlayWindow 的注释同理
  const { x: workAreaX, y: workAreaY, width: workAreaWidth, height: workAreaHeight } = target.workArea
  const { width, height } = size
  animateTo(win, {
    x: workAreaX + workAreaWidth - width,
    y: workAreaY + workAreaHeight - height,
    width,
    height,
  })
  return true
}

// 悬浮窗躲避状态：记录"进入躲避状态那一刻，悬浮窗当时所在的显示器 id"，之后每个 tick
// 只要仍需要躲避就复用这同一个 id 作为 moveToNonFullscreenDisplay 的排除项，不要每次都
// 用悬浮窗"当前"所在显示器重新计算——悬浮窗已经跳到别的屏幕之后，"当前所在显示器"会变成
// 刚跳过去的那块屏幕，若以它作排除项，双屏环境下会在两块屏幕之间每 500ms 来回反复横跳
// （排除 B 找到 A，下一 tick 排除 A 又找回 B）。
//
// overlayHomeBounds 是进入躲避前的原始坐标，跟聊天窗口的 homeBounds 同一套模式（两者是
// 完全独立的模块级变量，互不共享、互不影响）：躲避解除后用它 animateTo 归位。两者一起
// 在"从不躲避到躲避"的转变时刻记录一次，即便这次躲避最终因单屏/全部显示器被排除而跳不
// 出去、走 hide() 分支——那种情况下悬浮窗其实从未真正被移动过，overlayHomeBounds 记的
// 坐标与它当前实际坐标相同，之后归位时 animateTo 内部的 sameDisplay 守卫会让那次调用退化
// 成无位移的瞬时 setBounds，不产生任何可见位移，不需要为这个子情况单独判断跳过
let overlayDodgeSourceDisplayId: number | null = null
let overlayHomeBounds: Electron.Rectangle | null = null

// 悬浮窗躲避逻辑（chatIsHidden 时走这支）。activeWindowMonitor 只回传 isFullscreen/exeName/
// title，没有前台窗口的原始矩形，无法在这里反查它实际所在的显示器——按计划文档的简化，
// 直接尝试把悬浮窗移到"它自己当前所在显示器"之外的某块屏幕，不去追踪前台全屏窗口本身
// 在哪块屏幕
function handleOverlayDodge(info: ActiveWindowInfo, overlayWindow: BrowserWindow | null): void {
  if (!overlayWindow) return

  // 黑名单单独也算"必须躲避"（不要求同时全屏）：黑名单的语义是"这个程序不全屏也不能被
  // 悬浮窗盖住"，跟全屏走同一个分支
  const needsToDodge = info.isFullscreen || (info.exeName !== null && includesIgnoreCase(cachedConfig.blacklist, info.exeName))
  const isWhitelisted = info.exeName !== null && includesIgnoreCase(cachedConfig.fullscreenWhitelist, info.exeName)

  if (needsToDodge && !isWhitelisted) {
    // 判空条件用 overlayHomeBounds（而不是 overlayDodgeSourceDisplayId）：两者按上面注释
    // 描述的规律恒同步置空/置值，但只有让 TS 的窄化守卫直接检查 overlayHomeBounds 本身，
    // 才能在下面把它作为非空的 size 参数传给 moveToNonFullscreenDisplay 时通过类型检查——
    // 跟 handlePinMode 里 homeBounds 的判空写法保持一致
    if (overlayHomeBounds === null) {
      overlayHomeBounds = overlayWindow.getBounds()
      overlayDodgeSourceDisplayId = screen.getDisplayMatching(overlayHomeBounds).id
    }
    const moved = moveToNonFullscreenDisplay(overlayWindow, overlayDodgeSourceDisplayId as number, overlayHomeBounds)
    if (moved) {
      overlayWindow.showInactive()
    } else {
      // 没有别的屏幕可跳（单屏，或全部屏幕都是同一块）：直接隐藏，不能留在原地盖住全屏/
      // 黑名单程序
      overlayWindow.hide()
    }
  } else {
    // 不需要躲避（含"需要躲避但在白名单里，白名单胜出"）：若 overlayHomeBounds 有值，说明
    // 上一次是从躲避状态解除，先归位再重置状态——跟聊天窗口的 restoreHomeBoundsIfLeavingDodgeMode
    // 同一套模式。animateTo 走跟聊天窗口归位共用的动画逻辑，跳不出去、悬浮窗从未真正移动过
    // 的子情况见 overlayHomeBounds 声明处的注释，这里不需要额外判断
    if (overlayHomeBounds !== null) {
      animateTo(overlayWindow, overlayHomeBounds)
      overlayHomeBounds = null
    }
    overlayDodgeSourceDisplayId = null
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

// 聊天窗口置顶逻辑的"冲突态"记录：homeBounds 是进入冲突前的原始坐标（冲突解除后用它
// setBounds 归位），dodgeDisplayId 是进入冲突那一刻聊天窗口所在的显示器 id（视为被全屏
// 应用占用的屏幕）。两者一起在"从不冲突到冲突"的转变时刻记录一次，跟 overlayDodgeSourceDisplayId
// 同样的理由：避免每个 tick 都用聊天窗口"当前"所在显示器重新计算排除项，导致双屏来回横跳
let homeBounds: Electron.Rectangle | null = null
let dodgeDisplayId: number | null = null

// 切换到非 dodge-fullscreen 模式时，如果聊天窗口当下正卡在跳屏后的位置（homeBounds 有值），
// 必须先归位——否则用户在跳屏躲避期间把置顶模式切成"关闭"或"绝对置顶"，窗口会永久留在
// 跳过去的那块屏幕的角落里，homeBounds/dodgeDisplayId 也会变成没人再清理的孤儿状态。
//
// 两个调用点：① handlePinMode 每个 tick 都会经过这里（覆盖"轮询过程中前台窗口切换、
// 顺带发现 pinMode 也变了"这种情况）；② updateCachedWindowBehaviorConfig 在配置真正
// 改变的那一刻立即调用一次——这一条是必须的，不能只依赖①：用户改这个设置通常是在设置页/
// 托盘菜单里操作，那一刻前台窗口就是 MintBot 自己，activeWindowMonitor 会因为自我排除
// 返回 null，handleActiveWindowChange 整个短路，handlePinMode 根本不会被调用，若只有①，
// 归位会一直拖到用户下一次切到某个外部窗口才触发
function restoreHomeBoundsIfLeavingDodgeMode(mainWindow: BrowserWindow, pinMode: PinMode): void {
  if (pinMode !== 'dodge-fullscreen' && homeBounds !== null) {
    animateTo(mainWindow, homeBounds)
    // 归位的同时要把置顶态也校正到新模式该有的样子——这个函数现在有两个调用点：
    // handlePinMode 里紧跟着的 'off'/'always-on-top' 分支会自己调 setAlwaysOnTop，
    // 但 updateCachedWindowBehaviorConfig 是独立调用，没有后续分支兜底，不在这里
    // 一并处理的话，跳屏期间已经生效的 setAlwaysOnTop(true) 会一直卡住，直到下一次
    // 切到外部窗口触发轮询路径才被动更正——走 applyAlwaysOnTop 本身就是幂等的，不影响
    // handlePinMode 那边紧接着再调一次
    applyAlwaysOnTop(mainWindow, pinMode === 'always-on-top')
    homeBounds = null
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
    if (homeBounds === null) {
      homeBounds = mainWindow.getBounds()
      dodgeDisplayId = screen.getDisplayMatching(homeBounds).id
    }
    // 轮询每 500ms tick 一次，进入冲突后只要仍在冲突就会一直落到这个分支。跳屏动画本身
    // 约 360ms，通常在下一次 tick 前就已经跑完，但不能保证：若不加这道抑制，动画途中再
    // 调 moveToNonFullscreenDisplay 会拿"半路"的 getBounds() 当新起点重新起算一次动画，
    // 逐帧打断、可能来回抖动。跳过时不重复判断 moved/applyAlwaysOnTop——上一次已经跑完的
    // 那次调用已经把置顶态设成了该有的样子，本 tick 没有新信息，维持现状即可
    if (isAnimating()) return
    const moved = moveToNonFullscreenDisplay(mainWindow, dodgeDisplayId as number, homeBounds)
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
  } else if (homeBounds !== null) {
    // 冲突解除：归位 + 恢复置顶（P-2：dodge-fullscreen 非冲突态的基线是置顶，不再是取消
    // 置顶）+ 清掉记录。归位（animateTo）与置顶态无关，无条件执行
    animateTo(mainWindow, homeBounds)
    applyAlwaysOnTop(mainWindow, true)
    homeBounds = null
    dodgeDisplayId = null
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
