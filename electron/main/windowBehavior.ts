import { BrowserWindow, screen } from 'electron'
import type { ActiveWindowInfo } from './activeWindowMonitor'
import { animateTo, isAnimating } from './windowAnimation'
import { getPreferredBounds, setPreferredBounds, computeDefaultBoundsForDisplay, DEFAULT_WINDOW_SIZE, setLastDisplayId } from './windowPositions'
import type { WindowKey } from './windowPositions'

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

// 按 pinMode 套用置顶态的"基线"规则：只由 pinMode 本身决定目标态（'off' → false，
// 'always-on-top'/'dodge-fullscreen' → true，P-2：非冲突态基线已改为常驻置顶），三种模式
// 恰好用 pinMode !== 'off' 一个表达式覆盖。
//
// 但 dodge-fullscreen 且 dodgeDisplayId !== null 时必须跳过：那表示轮询驱动的 handlePinMode
// 已经判定当前存在全屏冲突并做过处置，其中"跳不出去只能让位"这一支会特意把置顶设成 false。
// 调用这个函数的两个时机（配置变更 / 冷启动）都可能发生在前台其实是 MintBot 自己的时刻，
// 那只说明"这一瞬间没有冲突"，不代表 handlePinMode 之前做的让位决定已经失效——无条件套用
// 基线会把窗口顶到全屏应用之上，直到下一次轮询才自我纠正。冲突态下的置顶归 handlePinMode
// 独占管理，这个函数只处理非冲突的基线情形。
//
// updateCachedWindowBehaviorConfig（配置变更）与 initWindowBehaviorConfig（冷启动）共用这
// 一份判断，避免两处各自维护同一条规则、之后改动只改了一处而彼此漂移
function applyBaselinePinMode(mainWindow: BrowserWindow, pinMode: PinMode): void {
  if (pinMode !== 'dodge-fullscreen' || dodgeDisplayId === null) {
    applyAlwaysOnTop(mainWindow, pinMode !== 'off')
  }
}

// mainWindow 传入是为了冷启动那一刻就把置顶态套用到主窗口——不能指望 handlePinMode 靠
// activeWindowMonitor 的下一次轮询来触发：应用刚启动时前台大概率就是 MintBot 自己，
// activeWindowMonitor 会因自我排除直接返回 null，handleActiveWindowChange 整个短路，
// handlePinMode 根本不会被调用，用户在切到外部窗口一次之前聊天窗口都不会置顶。
//
// fetch 失败（网络错误或响应非 2xx）时 cachedConfig 保留模块初始值 DEFAULT_CONFIG
// （pinMode: 'off'），下面仍会走 applyBaselinePinMode——对 'off' 该套用的目标态本来就是
// false，等价于什么都不做，不需要为失败路径单独分支
export async function initWindowBehaviorConfig(mainWindow: BrowserWindow | null): Promise<void> {
  try {
    const response = await fetch(`${CORE_URL}/config/window-behavior`)
    if (response.ok) {
      cachedConfig = await response.json()
    }
  } catch (err) {
    console.error('[WindowBehavior] Failed to fetch initial config, using defaults:', err)
  }
  // isDestroyed 守卫：本函数在 await fetch 前后跨了异步，mainWindow 是调用时刻捕获的引用，
  // 窗口若在这期间被销毁，setAlwaysOnTop 会抛在一个 fire-and-forget 的 Promise 上（调用点
  // 不 await），变成未捕获的 rejection。与本文件/index.ts 中其它跨异步使用窗口引用的地方
  // 同一写法（positionOnChatDisplay、设置窗口那条 handler）。实际竞态窗口极小，属防御
  if (mainWindow && !mainWindow.isDestroyed()) {
    // 与 updateCachedWindowBehaviorConfig 做同样的两步，不能只做后一步。本函数现在不只
    // 在冷启动时跑——SSE 每次重连成功都会再跑一次以重新同步配置（见 index.ts 的重连循环），
    // 而断线期间用户完全可能改过 pinMode。若这里只 applyBaselinePinMode，遇到「断线期间从
    // dodge-fullscreen 切走、且当时正在跳屏躲避」这种组合，缓存更新了但 dodgeDisplayId 仍
    // 悬着、窗口也不归位。轮询会在 500ms 内自愈，但没有理由让两个调用点对同一条规则做得
    // 不一样。冷启动时 dodgeDisplayId 必为 null，这一步是 no-op，加上它不影响原有路径
    // 单独一个 try，不并进上面那个：上面那个包着 fetch，合并后 fetch 失败就会跳过 apply，
    // 而「取不到配置时也按默认值 apply 一次」是刻意的（见函数头注释）。这里要防的是另一件
    // 事——上面的 isDestroyed() 只收窄、没有消除 TOCTOU：窗口可能在检查之后、原生调用之前
    // 被销毁，setBounds/setAlwaysOnTop 便会抛错。本函数是 fire-and-forget 调用的（两个调用点
    // 都不 await），抛出去就是未捕获的 rejection。冷启动时这段只跑一次，现在 SSE 每次重连
    // 都会再跑一次，暴露面随之放大，因此在函数内部收口一次，而不是让每个调用点各自 .catch()
    try {
      restoreHomeBoundsIfLeavingDodgeMode(mainWindow, cachedConfig.pinMode)
      applyBaselinePinMode(mainWindow, cachedConfig.pinMode)
    } catch (err) {
      console.error('[WindowBehavior] Failed to apply pin state:', err)
    }
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
    // 才补上（见上面 restoreHomeBoundsIfLeavingDodgeMode 的调用点注释）。守卫逻辑与
    // initWindowBehaviorConfig 共用 applyBaselinePinMode，见该函数注释
    applyBaselinePinMode(mainWindow, config.pinMode)
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
// （见该函数注释）。
//
// 按 WindowKey 分别记录，不再是模块级单一时间戳：聊天窗口与悬浮窗现在会在同一个 tick 各自
// 独立触发跳屏/归位（见 handleActiveWindowChange 不再是 either/or）。若仍共用一份时间戳，
// 悬浮窗的一次跳屏会刷新这个值，若用户紧接着（1 秒冷却期内）真的手动拖动了聊天窗口，
// persistBoundsNow('chat', ...) 会因为读到「刚刚有过一次程序移动」而误判成本窗口自己的余波，
// 把这次真实的用户拖动漏记进偏好表——两个窗口的冷却期必须互不影响
const lastProgrammaticMoveAt = new Map<WindowKey, number>()

// 供 index.ts 在 new BrowserWindow(...) 之后立刻调用一次。构造函数的 x/y/width/height
// 同样是一次「程序放置窗口」，和 animateTo 没有本质区别，却一直没有被记进这个时间戳：
// Windows 会在窗口刚落到某块屏上时异步发一次 WM_DPICHANGED 校正（见 windowAnimation.ts
// 顶部关于 electron#27651 的说明），那次校正触发的 moved/resize 到达 handleWindowMoved 时
// lastProgrammaticMoveAt 还是初值、isAnimating() 也为 false，于是漂移后的矩形会被当成
// 用户手动调整写进偏好表。以前启动不读表，这种错写只影响后续跳屏；现在启动要从表里恢复，
// 它会变成那块屏永久的「标准尺寸」
export function markProgrammaticWindowPlacement(windowKey: WindowKey): void {
  lastProgrammaticMoveAt.set(windowKey, Date.now())
}

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
// 尺寸不再由调用方传入的"当前窗口现场读数"决定（那正是历史相关、会累积漂移的旧设计）——
// computeDefaultBoundsForDisplay 现在只依赖 windowPositions.ts 里全局的密度锚点规则：
// 目标屏该多大只取决于"当前连接的显示器都有谁"，跟窗口从哪块屏跳过来的完全无关（history
// independent，见该函数注释），因此这里不再需要 baseline/baselineDisplay 参数
//
// 跳屏动画：走 animateTo 而不是直接 setBounds，悬浮窗和聊天窗口共用这个函数，因此两者的
// 跳屏都会带上划出/飞入动画（同屏调用会被 animateTo 内部的前置守卫短路成瞬间跳（尺寸守卫已随飞近动画一并移除——尺寸不再参与补间））。
// 这里不使用 animateTo 返回的取消函数——中断处理（最小化/隐藏/关闭/销毁）已经由
// windowAnimation.ts 内部的一次性监听自行兜底，调用方不需要持有它
export function moveToNonFullscreenDisplay(
  win: BrowserWindow,
  windowKey: WindowKey,
  excludeDisplayId: number
): boolean {
  const displays = screen.getAllDisplays()
  const target = displays.find(display => display.id !== excludeDisplayId)
  if (!target) return false

  let bounds = getPreferredBounds(windowKey, target.id)
  if (!bounds) {
    bounds = computeDefaultBoundsForDisplay(target, displays, DEFAULT_WINDOW_SIZE[windowKey], windowKey)
    setPreferredBounds(windowKey, target.id, bounds)
  }

  lastProgrammaticMoveAt.set(windowKey, Date.now())
  animateTo(win, bounds)
  return true
}

// 归位（"跳回原来那块屏幕"）用的也是同一套查表逻辑：目标显示器换成"进入躲避前所在的
// 那块屏幕"，查到偏好位置就直接用。查不到时理论上不应该发生——首次躲避进入某块目标屏时，
// moveToNonFullscreenDisplay 已经会把它的偏好记录补上；这块"家"屏幕本身理应早已有记录
// （启动恢复/上一次归位都会补），这里只是一道兜底安全网。homeDisplay 本身已经从当前连接的
// 显示器里消失（比如被拔掉）时不归位，原地不动——没有目标显示器的 workArea 可用，没法算出
// 任何有意义的落点。
//
// 兜底分支不再需要现读"窗口此刻实际所在的显示器"当基准——旧版本这里曾经因为拿跳屏目的地
// 当基准，在缩放比例不同的双屏环境下把窗口尺寸永久搞错（review 抓到的 bug）；现在
// computeDefaultBoundsForDisplay 完全不依赖调用方传入的现场读数，这一类 bug 从根上不再
// 可能出现。
//
// 现在唯一的调用点是 restoreHomeBoundsIfLeavingDodgeMode（用户在设置页/托盘菜单主动切走
// dodge-fullscreen 模式那一刻的归位）。handlePinMode/handleOverlayDodge 里"全屏冲突自然
// 解除"这两条路径不再调用它——冲突解除时窗口已经稳定停在跳屏目标屏上，不需要再挪回去，
// 见两处调用点各自的注释
function restoreToDisplay(win: BrowserWindow, windowKey: WindowKey, homeDisplayId: number): void {
  const displays = screen.getAllDisplays()
  const homeDisplay = displays.find(display => display.id === homeDisplayId)
  if (!homeDisplay) return

  let bounds = getPreferredBounds(windowKey, homeDisplayId)
  if (!bounds) {
    bounds = computeDefaultBoundsForDisplay(homeDisplay, displays, DEFAULT_WINDOW_SIZE[windowKey], windowKey)
    setPreferredBounds(windowKey, homeDisplayId, bounds)
  }

  lastProgrammaticMoveAt.set(windowKey, Date.now())
  animateTo(win, bounds)
}

// 'moved' 监听回调（index.ts 在创建 mainWindow/overlayWindow 时各自注册一次）：命中即认定
// 用户真实拖动了窗口，把拖动后的位置/所在显示器写回偏好表——查表设计下这是表里数据"随时间
// 更新"的唯一渠道（跳屏本身只读表，不写表，除了首次在某块显示器出现时的一次性默认值）。
//
// 需要排除两类"不是用户拖动"的触发：① 动画进行中（isAnimating()）——划出/划入两段补间
// 过程中每一帧都调用 setBounds，会连续触发 'moved'；② 程序刚调用完 animateTo 的冷却期内（不足
// 1 秒）——动画结束那一刻的最终 setBounds 与后续可能出现的异步 WM_DPICHANGED 纠正都可能
// 再触发一次 'moved'，冷却期把这些程序自己的动作也滤掉。悬浮窗当前 resizable: false 且
// 没有暴露拖动交互，这个监听器对它而言目前是"装着但触发不到"——以后如果悬浮窗支持拖动，
// 直接生效，不需要再改这部分
// 落盘防抖。'moved' 与 'resize' 都汇到本函数，而**两者在一次拖拽里都是逐帧连续触发的**：
// 从上边/左边拖拽缩放会同时改变原点，Windows 会一路发 move。因此防抖必须放在这个公共入口，
// 而不是某一个监听点上——放在监听点只会保护到那一种拖法，另一种照样每帧一次同步
// writeFileSync + renameSync。按 windowKey 分别计时，聊天窗与悬浮窗互不干扰
const PERSIST_DEBOUNCE_MS = 300
const persistTimers = new Map<WindowKey, ReturnType<typeof setTimeout>>()

// 该窗口此刻是否正停在跳屏目标上。这与下面的时间守卫是**两件不同的事**：时间守卫挡的是
// 「程序自己刚移动完」的余波，而这个挡的是「窗口在整段冲突期间一直停在别处」——两者时长
// 完全不同，一次全屏会话可以持续几十分钟，远超那 1 秒
function isDodgeParked(windowKey: WindowKey): boolean {
  return windowKey === 'chat' ? dodgeDisplayId !== null : overlayDodgeSourceDisplayId !== null
}

function persistBoundsNow(windowKey: WindowKey, win: BrowserWindow): void {
  // isAnimating(win)：只查这个窗口自己是否在动画中，不再是模块级共享信号——两个窗口现在
  // 可能同一 tick 各自独立动画，另一个窗口在动不代表这个窗口的 getBounds() 不可信。冷却期
  // 时间戳同理按 windowKey 分别查（见 lastProgrammaticMoveAt 定义处注释）
  if (isAnimating(win) || Date.now() - (lastProgrammaticMoveAt.get(windowKey) ?? 0) < 1000) return
  // 跳屏期间一律不写表。缺了这条，一次迟到的 WM_DPICHANGED 尺寸校正（windowAnimation.ts
  // 顶部注释记录了它异步且可能迟到，没有上界）会在 1 秒时间窗之后到达，被当成用户手动
  // resize 写进偏好表，把该显示器上真正的用户偏好覆盖掉。此前只监听 'moved' 时这条缺口
  // 咬不到人——纯尺寸变化不触发 'moved'；接上 'resize' 之后它就真实可达了
  if (isDodgeParked(windowKey)) return
  const bounds = win.getBounds()
  const displayId = screen.getDisplayMatching(bounds).id
  setPreferredBounds(windowKey, displayId, bounds)
}

export function handleWindowMoved(windowKey: WindowKey, win: BrowserWindow): void {
  const pending = persistTimers.get(windowKey)
  if (pending) clearTimeout(pending)
  persistTimers.set(windowKey, setTimeout(() => {
    persistTimers.delete(windowKey)
    if (win.isDestroyed()) return
    persistBoundsNow(windowKey, win)
  }, PERSIST_DEBOUNCE_MS))
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

// handleOverlayDodge 的前置守卫，抽成纯函数供单测——本模块其余部分依赖真实 BrowserWindow
// （isVisible）与模块内可变状态，不可测；这条守卫只依赖这两个值本身，可以独立验证（跟
// windowAnimation.ts 的 evaluateAnimationGuards 同一个约定）。
//
// 悬浮窗现在跟聊天窗口的置顶逻辑独立跑，每个 tick 都会被调用到，不再只在聊天窗口不可见时
// 才有机会执行——因此"悬浮窗此刻是不是隐藏的"不能再默认等于"不需要处理"。隐藏且没有正
// 处于跳屏/让位追踪状态（dodgeSourceDisplayId === null）时才真正什么都不用做：这通常是
// 聊天窗口拿到焦点后的正常态，继续判断是无用功，且 handleOverlayDodge 归位分支末尾的
// showInactive() 兜底会在这种情况下把它重新显示出来，与"聊天窗口聚焦时收起悬浮窗"的既有
// 约定打架。若正处于追踪状态（之前跳屏又因单屏落回 hide() 分支），必须放行继续处理，否则
// 冲突解除时永远等不到归位/重新显示
export function shouldSkipOverlayDodge(overlayVisible: boolean, dodgeSourceDisplayId: number | null): boolean {
  return !overlayVisible && dodgeSourceDisplayId === null
}

// 悬浮窗躲避逻辑。activeWindowMonitor 只回传 isFullscreen/exeName/title/displayId，没有
// 前台窗口的原始矩形，无法在这里反查它实际所在的显示器——按计划文档的简化，直接尝试把
// 悬浮窗移到"它自己当前所在显示器"之外的某块屏幕，不去追踪前台全屏窗口本身在哪块屏幕
//
// review 发现的 BLOCKER：mainWindow 参数是补上的。之前 showInactive() 只看
// needsToDodge/isWhitelisted，不看聊天窗口此刻是否持有焦点——TDD §2.3「焦点回到本应用时
// 收起悬浮窗」与"悬浮窗常驻桌面、不受聊天窗口状态影响地躲避全屏"这两条规则都必须成立，
// 但两者在"仍处于跳屏追踪状态（overlayDodgeSourceDisplayId !== null）"这一支上会冲突：
// 聊天窗口 'focus' 监听（index.ts）已经 hide() 过悬浮窗，但那只是一次性事件；紧接着的下
// 一次轮询 tick 如果仍判定 needsToDodge，会在没有任何新信息的情况下把它重新 showInactive()
// 出来，而且此后不会再有 'focus' 事件来收起它——一旦露出就卡住。
// 不采用"记一个锁存标志、被 focus 事件置位"的方案：锁存值只能被同一个事件类型清除，
// 而"聊天窗口失焦、需要恢复躲避"没有对应的一次性事件可以清它，会话如果先失焦后没有再次
// 触发 focus，标志会一直卡在"隐藏"，悬浮窗永远等不到重新出现。改为每个 tick 都重新查询
// mainWindow.isFocused()（而不是缓存/锁存），这样两条规则都能保持自洽：聊天窗口持有焦点
// 期间恒定压住 showInactive()；聊天窗口一旦失焦，下一次触发本函数的 tick 立刻放行
function handleOverlayDodge(info: ActiveWindowInfo, overlayWindow: BrowserWindow | null, mainWindow: BrowserWindow | null): void {
  if (!overlayWindow) return

  const chatFocused = mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isFocused()

  // 悬浮窗现在跟聊天窗口的置顶逻辑独立跑（见 handleActiveWindowChange），不再只在聊天窗口
  // 不可见时才被调用——因此这里必须自己判断"这一 tick 值不值得处理"。悬浮窗隐藏且没有
  // 正处于跳屏/让位追踪状态时直接跳过：隐藏多数时候是聊天窗口拿到焦点后的正常态（见
  // index.ts 的 focus 监听），继续跑跳屏判断是纯粹的无用功，且下面归位分支末尾的
  // showInactive() 兜底会在这种情况下把它重新显示出来，与"聊天窗口聚焦时收起悬浮窗"的既有
  // 约定打架。若正处于跟踪状态（overlayDodgeSourceDisplayId !== null，即之前跳屏又因单屏
  // 落回 hide() 分支），必须继续跑，否则冲突解除时永远等不到归位/重新显示
  if (shouldSkipOverlayDodge(overlayWindow.isVisible(), overlayDodgeSourceDisplayId)) return

  // 上一轮跳屏/归位动画还没结束时整体跳过这个 tick，不只是为了避免半路打断动画（那部分
  // 交给 animateTo 自己的取消/重开逻辑处理，本来就是安全的）——更重要的是下面
  // overlayDodgeSourceDisplayId === null 那次性判定"家是哪块屏幕"必须读到窗口真正静止
  // 时的坐标，动画进行中读 getBounds() 可能读到半路的位置，把 screen.getDisplayMatching
  // 判断成错误的显示器，之后归位就会归错地方。isAnimating(overlayWindow) 只查悬浮窗自己
  // 是否在动画中——聊天窗口现在可能同一 tick 独立动画，不再是共享单飞状态，因此这里不会
  // 因为聊天窗口在动而被连带跳过
  if (isAnimating(overlayWindow)) return

  // 黑名单单独也算"必须躲避"（不要求同时全屏）：黑名单的语义是"这个程序不全屏也不能被
  // 悬浮窗盖住"，跟全屏走同一个分支
  const needsToDodge = info.isFullscreen || (info.exeName !== null && includesIgnoreCase(cachedConfig.blacklist, info.exeName))
  const isWhitelisted = info.exeName !== null && includesIgnoreCase(cachedConfig.fullscreenWhitelist, info.exeName)

  if (needsToDodge && !isWhitelisted) {
    if (overlayDodgeSourceDisplayId === null) {
      overlayDodgeSourceDisplayId = screen.getDisplayMatching(overlayWindow.getBounds()).id
    }
    // moveToNonFullscreenDisplay 现在完全自己查表/算默认值（见该函数注释），不再需要
    // 调用方传入现场读数当基准
    const moved = moveToNonFullscreenDisplay(overlayWindow, 'overlay', overlayDodgeSourceDisplayId)
    if (moved) {
      // 只在聊天窗口此刻没有焦点时才显示——见函数头注释。永远不用 show()：这里从来
      // 不该抢焦点，chatFocused 只决定"是否显示"，不改变 showInactive 本身
      if (!chatFocused) {
        overlayWindow.showInactive()
      }
    } else {
      // 没有别的屏幕可跳（单屏，或全部屏幕都是同一块）：直接隐藏，不能留在原地盖住全屏/
      // 黑名单程序
      overlayWindow.hide()
    }
  } else {
    // 问题1b：只有前台窗口确实落在"家"（进入躲避前所在）那块屏幕上，才认定冲突解除、可以
    // 归位——否则保持当前已经躲避到的位置不变（既不归位，也不重新计算新的跳屏目标：已经
    // 在一个安全的地方了，对"家"那块屏幕现状没有任何新信息之前不需要动）。
    //
    // 用户报告的缺陷：冲突解除后不再调用 restoreToDisplay 把悬浮窗拖回"家"（原来那块屏，
    // 也正是刚刚全屏过的那块）。悬浮窗此刻已经稳定停在跳屏目标屏上——这本身就是一块没有
    // 冲突的好屏幕，拖回去没有任何必要，只会制造一次可见的"飞回"。改为原地不动，只清掉
    // 追踪状态；同时把当前所在的屏幕采纳为下次启动的"家"（setLastDisplayId），
    // 而不是让 lastDisplayId 继续指向已经离开的那块屏——否则下次启动会把悬浮窗放回
    // 用户已经主动"搬家"离开的位置
    if (overlayDodgeSourceDisplayId !== null && info.displayId === overlayDodgeSourceDisplayId) {
      setLastDisplayId('overlay', screen.getDisplayMatching(overlayWindow.getBounds()).id)
      overlayDodgeSourceDisplayId = null
    }
    // 已核实 showInactive 走 ShowWindow(SW_SHOWNOACTIVATE)，不像 setAlwaysOnTop 那样必然
    // 带一次 SetWindowPos；但 ShowWindow 对"已经可见"的窗口是否触碰 z-order 微软文档未
    // 定义，不能假设它是安全的 no-op。这里每次 onChange 只要判定不需要躲避就会走到这一行，
    // 500ms 轮询下同样有反复重复调用的风险，加可见性守卫让已显示时成为彻底的 no-op——
    // dodge 分支里 hide() 之后 isVisible() 为 false，守卫照常放行，无回归。
    //
    // 上面 moved 分支的 showInactive() 没有加同款可见性守卫，这个不对称是刻意的、不是
    // 遗漏：那一支每 tick 都会先无条件跑一次 moveToNonFullscreenDisplay() → setBounds()，
    // setBounds 本身就是个更大的重复调用源（且尚未做"位置未变则跳过"的幂等化），
    // 只给它的 showInactive 加可见性守卫遮不住 setBounds，收益接近零。真要收敛那一支，
    // 该做的是给 moveToNonFullscreenDisplay 加位置幂等判断，那是另一件事。
    //
    // chatFocused 守卫则两支都要加，同一个理由：冲突解除、归位完成的这一刻，如果聊天
    // 窗口恰好持有焦点，仍然不能把悬浮窗重新显示出来（同函数头注释的 BLOCKER）
    if (!overlayWindow.isVisible() && !chatFocused) {
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
// 归位延迟重试的轮询间隔：仅用于"当前正有一段跳屏/归位动画在飞"这一种情形下的短暂等待，
// 不是给这个函数常态使用的节奏。500ms 的三段式动画（EXIT_DURATION_MS + ENTRANCE_DURATION_MS，
// 见 windowAnimation.ts）跑完之前，isAnimating(mainWindow) 恒为 true；选一个明显小于该总时长
// 的固定间隔重新检查，而不是一次性等满整个时长再查——等待期间随时可能又有新一轮动画被
// 触发（比如又一次跳屏/归位互相追赶），固定短间隔能在下一次机会窗口里发现它仍在动，不用
// 赌一次时长刚好够
const RESTORE_RETRY_MS = 60

function restoreHomeBoundsIfLeavingDodgeMode(mainWindow: BrowserWindow, pinMode: PinMode): void {
  if (pinMode !== 'dodge-fullscreen' && dodgeDisplayId !== null) {
    // 本函数有三个调用点：handlePinMode 每个 tick 无条件调一次（轮询驱动），以及
    // updateCachedWindowBehaviorConfig / initWindowBehaviorConfig 在配置变更/冷启动那一刻
    // 各调一次（均非轮询驱动、不会自动重试）。三者都可能撞上"聊天窗口这一刻正有一段跳屏/
    // 归位动画在飞"——若不管三七二十一直接调 restoreToDisplay，会撞上 animateTo 的重入
    // 处理：正在飞的动画被瞬间 snap 到旧 target，再飞向新 target，产生本可避免的
    // snap-then-refly 闪烁（三段式改造把总时长从 180ms 拉到 500ms 之后，这个时间窗明显
    // 更容易被撞上）。最终落点仍然正确，纯粹是可见的过渡瑕疵。
    //
    // 这里不能简单地整体跳过这次调用——handlePinMode 的轮询路径尚有"下一次前台窗口变化"
    // 兜底，但 updateCachedWindowBehaviorConfig/initWindowBehaviorConfig 是一次性调用，
    // 跳过之后不保证短时间内还有别的路径会再次触发同一次归位，dodgeDisplayId 会一直悬着、
    // 窗口永久卡在跳屏位置。改成短延迟后重新调用自己，而不是直接丢弃——dodgeDisplayId
    // 在等待期间保持不变（未清空），归位请求本身没有丢失，只是推迟到动画结束后的下一次
    // 检查；重试时重新读 cachedConfig.pinMode 而不是复用这次调用捕获的参数，防止等待
    // 期间配置又变了一次、拿着过期判断结果误归位或误跳过
    if (isAnimating(mainWindow)) {
      setTimeout(() => {
        if (!mainWindow.isDestroyed()) restoreHomeBoundsIfLeavingDodgeMode(mainWindow, cachedConfig.pinMode)
      }, RESTORE_RETRY_MS)
      return
    }
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
  // 上一轮跳屏/归位动画还没结束时整个 dodge-fullscreen 分支这一 tick 都跳过——不只是
  // inContention 这一支需要它：下面 else if 分支的归位调用同样会走 restoreToDisplay →
  // animateTo，若这一刻窗口仍在飞，会撞上 animateTo 的重入处理（正在飞的动画被瞬间 snap
  // 到旧 target，再飞向新 target），产生可避免的 snap-then-refly 闪烁——跟
  // restoreHomeBoundsIfLeavingDodgeMode 需要处理的是同一类问题（见该函数注释），只是
  // 触发路径不同。之前这条守卫只挂在 inContention 内部，等价于假设"归位调用不会撞上
  // 动画"，三段式改造把总时长从 180ms 拉到 500ms 之后这个假设不再成立，因此把守卫提到
  // 整个 dodge-fullscreen 分支最前面，覆盖 inContention 与 else if 两支（跟
  // handleOverlayDodge 的守卫放在整个函数最前面是同一个约定）。
  //
  // 提到这里不会漏掉"每 tick 都必须做"的事：'off'/'always-on-top' 分支已经在上面 return
  // 过，不受影响；下面 else 分支（从未冲突过）只调用幂等的 applyAlwaysOnTop(true)，被
  // 这次跳过延后一个 tick 无害——已核实 isAnimating(mainWindow) 为真时必然是本文件的
  // dodge/归位流程正在跑（唯一会对 mainWindow 调用 animateTo 的调用点就是
  // moveToNonFullscreenDisplay/restoreToDisplay，两者都只在 dodgeDisplayId 有值时触发），
  // 因此这一刻 dodgeDisplayId 不可能是 null，else 分支实际上不会被这条守卫拦到。
  //
  // inContention 分支内部原本还需要这条守卫的理由（避免动画途中读到"半路"的 getBounds()，
  // 把 screen.getDisplayMatching 判断成错误的显示器）依然成立，只是判断本身现在提到了
  // 分支外层，不需要在 inContention 内部重复写一次
  if (isAnimating(mainWindow)) return

  const isWhitelisted = info.exeName !== null && includesIgnoreCase(fullscreenWhitelist, info.exeName)
  const inContention = info.isFullscreen && !isWhitelisted

  if (inContention) {
    if (dodgeDisplayId === null) {
      dodgeDisplayId = screen.getDisplayMatching(mainWindow.getBounds()).id
    }
    // moveToNonFullscreenDisplay 现在完全自己查表/算默认值（见该函数注释），不再需要
    // 调用方传入现场读数当基准
    const moved = moveToNonFullscreenDisplay(mainWindow, 'chat', dodgeDisplayId)
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
    // 结束追踪——否则保持当前已经躲避到的位置不变，对"家"那块屏幕现状没有任何新信息之前不
    // 归位、也不重新计算新的跳屏目标。
    //
    // 用户报告的缺陷：这里原先会调 restoreToDisplay 把聊天窗口拖回"家"（dodgeDisplayId，
    // 即进入冲突前所在、也正是刚刚全屏过的那块屏）。但聊天窗口此刻已经稳定停在跳屏目标屏
    // 上——这本身就是一块没有冲突的好屏幕，拖回去没有必要，只会制造一次可见的"飞回"（用户
    // 报告的原话）。改为原地不动，只清掉追踪状态 + 恢复置顶（P-2：dodge-fullscreen 非冲突
    // 态的基线是置顶）；同时把当前所在的屏幕采纳为下次启动的"家"（setLastDisplayId），
    // 而不是任由 lastDisplayId 继续指向已经离开的那块屏——否则下次启动又会把窗口放回
    // 用户已经主动"搬家"离开的位置，等于把这次修复的效果推迟到下次启动才显现
    if (info.displayId === dodgeDisplayId) {
      applyAlwaysOnTop(mainWindow, true)
      setLastDisplayId('chat', screen.getDisplayMatching(mainWindow.getBounds()).id)
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

  // 悬浮窗常驻桌面，是否被全屏应用/黑名单程序挡住跟聊天窗口此刻是不是"当前展示方"无关——
  // 不再是原来的 either/or（旧版本的前提"同一时刻只有一个窗口在展示"对聊天窗口成立，对
  // 悬浮窗不成立：聊天窗口打开但没有焦点时，悬浮窗完全可能仍然可见，也就仍然需要躲避）。
  // 两条判断各自独立跑，真正决定要不要处理悬浮窗躲避的是它自己的可见性/追踪状态，见
  // handleOverlayDodge 内部的 shouldSkipOverlayDodge 守卫
  handleOverlayDodge(info, overlayWindow, mainWindow)

  // 聊天窗口"不可见"（已最小化/隐藏/关闭）时没有置顶态需要维持，这部分判断条件不变，仍然
  // 只在聊天窗口可见且未最小化时才走置顶逻辑
  if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()) {
    handlePinMode(info, mainWindow)
  }
}
