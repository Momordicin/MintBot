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
    // 悬着、这次跳屏 episode 也结不了账（置顶态校正不到位，当前屏幕也没被采纳成家）。轮询
    // 会在 500ms 内自愈，但没有理由让两个调用点对同一条规则做得不一样。冷启动时
    // dodgeDisplayId 必为 null，这一步是 no-op，加上它不影响原有路径
    // 单独一个 try，不并进上面那个：上面那个包着 fetch，合并后 fetch 失败就会跳过 apply，
    // 而「取不到配置时也按默认值 apply 一次」是刻意的（见函数头注释）。这里要防的是另一件
    // 事——上面的 isDestroyed() 只收窄、没有消除 TOCTOU：窗口可能在检查之后、原生调用之前
    // 被销毁，setBounds/setAlwaysOnTop 便会抛错。本函数是 fire-and-forget 调用的（两个调用点
    // 都不 await），抛出去就是未捕获的 rejection。冷启动时这段只跑一次，现在 SSE 每次重连
    // 都会再跑一次，暴露面随之放大，因此在函数内部收口一次，而不是让每个调用点各自 .catch()
    try {
      endDodgeEpisodeIfLeavingDodgeMode(mainWindow, cachedConfig.pinMode)
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
// 结束 episode 的需求——不能指望 handlePinMode 的同款守卫逻辑靠 activeWindowMonitor 的
// 下一次轮询来触发：用户改这个设置的方式通常是打开设置页/托盘菜单，这一刻前台窗口就是
// MintBot 自己，activeWindowMonitor 会因为自我排除直接返回 null，handleActiveWindowChange
// 整个短路，handlePinMode 根本不会被调用，结束 episode 会一直拖到用户下一次切到某个
// 外部窗口才触发——这里在配置真正改变的那一刻就直接做一次检查，不依赖轮询
export function updateCachedWindowBehaviorConfig(config: WindowBehaviorConfig, mainWindow: BrowserWindow | null): void {
  cachedConfig = config
  if (mainWindow) {
    endDodgeEpisodeIfLeavingDodgeMode(mainWindow, config.pinMode)
    // P-3：配置变更这一刻立即把置顶态套用到新模式，不等下一次轮询——不然从设置页/托盘
    // 切完模式后，置顶态要拖到用户下一次切到外部窗口、handlePinMode 被轮询驱动调用时
    // 才补上（见上面 endDodgeEpisodeIfLeavingDodgeMode 的调用点注释）。守卫逻辑与
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

// 程序自己上一次调用 animateTo 的时间戳（moveToNonFullscreenDisplay 更新——曾经的
// restoreToDisplay 也更新过，该函数已随聊天窗口切走 dodge-fullscreen 模式时"原地不动、
// 不再归位"的改动整体删除，见 endDodgeEpisodeIfLeavingDodgeMode 注释），供
// handleWindowMoved 判断某次 'moved' 事件是不是程序自己刚移动完的余波（见该函数注释）。
//
// 按 WindowKey 分别记录，不再是模块级单一时间戳：聊天窗口与悬浮窗现在会在同一个 tick 各自
// 独立触发跳屏（见 handleActiveWindowChange 不再是 either/or）。若仍共用一份时间戳，
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

// restoreToDisplay（"跳回原来那块屏幕"，曾经用于聊天窗口切走 dodge-fullscreen 模式那一刻
// 的归位，以及历史上悬浮窗的归位）已删除——两条调用路径都改成了"原地不动 + 把当前屏幕
// 采纳为家"，不再需要任何"飞回某块显示器"的实现，见 endDodgeEpisodeIfLeavingDodgeMode 与
// handlePinMode/handleOverlayDodge 里"全屏冲突自然解除"分支各自的注释

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

// 悬浮窗躲避状态：保留"当前这次躲避对应的冲突（全屏/黑名单前台窗口）所在的显示器 id"
// 这一个整数，不再额外维护一份捕获的坐标（旧版本的 overlayHomeBounds）——查表设计下，
// 跳屏目标改由 moveToNonFullscreenDisplay 现查 windowPositions.ts 的持久化表（历史上归位
// 目标也曾由 restoreToDisplay 现查同一张表，该函数已整体删除，见下方
// endDodgeEpisodeIfLeavingDodgeMode 注释），不需要在内存里另存一份"某一刻捕获的坐标"，
// 也就没有它可能过期/漂移的问题。
//
// 曾经的缺陷①：这里错误地记录成"悬浮窗自己当时所在的显示器 id"
// （screen.getDisplayMatching(overlayWindow.getBounds())），而不是冲突所在的显示器——两者
// 只在第一次躲避那一刻恰好相等（悬浮窗还没挪走）。用户报告的两个现象都源于此：①悬浮窗
// 所在屏幕之外发生全屏也会无差别跳屏；②第二次全屏冲突发生时，悬浮窗自己所在的显示器已经
// 变成上一次跳去的目标屏，导致这次反而把悬浮窗排回冲突屏本身。现在改为直接采用
// ActiveWindowInfo.displayId（前台冲突窗口所在的显示器，activeWindowMonitor 保证非空时
// 必已解析），见 decideDodge。
//
// 曾经的缺陷②（review finding A，修复缺陷①时引入）：当时只在 `=== null` 时赋值一次
// （"进入躲避状态那一刻的冲突显示器"，此后固定不变），冲突中途换屏时会失效——悬浮窗躲到
// B 之后，若同一个冲突窗口被拖到 B（或另一个冲突恰好出现在 B），排除项仍是过期的 A，
// displays.find(d => d.id !== A) 会解出 B——也就是悬浮窗当前已经在的、真正被遮挡的那块
// 屏幕，跳屏变成 no-op，悬浮窗永久卡在冲突之上。现在改为每个 tick 都无条件用本 tick 的
// info.displayId 覆盖，让它始终代表"最新已知的冲突显示器"，而不是"进入躲避那一刻"的快照。
//
// 下面这句针对的是另一种、更早就存在的误用，跟上面两条缺陷不是同一件事，仍然成立、
// 不要跟"每 tick 刷新冲突显示器"混淆：不要用"悬浮窗自己当前所在的显示器"重新计算这个
// 跟踪值——悬浮窗已经跳到别的屏幕之后，"当前所在显示器"会变成刚跳过去的那块屏幕，若以它
// 作为跟踪值/排除项，双屏环境下会在两块屏幕之间每 500ms 来回反复横跳（排除 B 找到 A，
// 下一 tick 排除 A 又找回 B）。每 tick 必须刷新的是 info.displayId（冲突所在的显示器），
// 悬浮窗自己所在的显示器永远不能被当作排除项来源
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

// handleOverlayDodge 判断"这一 tick 该不该躲避、躲去哪块显示器"的纯函数部分，抽出来跟
// shouldSkipOverlayDodge 同一个理由——只依赖几个显示器 id/布尔值，脱离真实
// BrowserWindow.getBounds()/screen 也能验证。
//
// review finding E：这里刻意把"排除目标（excludeDisplayId）该取哪个值"也纳入这个纯函数的
// 返回值，而不是只返回一个布尔值再让调用方自己决定传什么给 moveToNonFullscreenDisplay——
// 之前的版本只测了等价于本函数内部比较的一个布尔判断，从未测过调用点实际传给
// moveToNonFullscreenDisplay 的排除项，哪怕调用点整段被改回原始缺陷（比如排除项重新变成
// 本窗口自己的显示器，或沿用过期的跟踪值），那批测试也不会失败。把排除目标的选择收进这个
// 纯函数、调用方只管照办，回归才有可能在不启动真实 Electron 的情况下被单测拦住。
//
// 这是本次修复的核心：只有本窗口自己当前所在的显示器（ownDisplayId）与冲突（全屏/
// 黑名单前台窗口）所在的显示器（conflictDisplayId，来自 ActiveWindowInfo.displayId）
// 一致时才算被遮挡，需要挪走；冲突发生在别的屏幕上跟本窗口毫无关系，不该动它。悬浮窗的
// 旧实现从未做这个比较——直接把"悬浮窗自己当前所在的显示器"当排除项传给
// moveToNonFullscreenDisplay，等价于逢冲突必躲。用户报告的两个现象都源于此：①悬浮窗
// 所在屏幕之外发生全屏也会无差别跳屏；②躲避一次之后悬浮窗自己所在的显示器已经变成跳去的
// 目标屏，第二次冲突再发生时，旧逻辑重新拿它当基准，反而把悬浮窗排回冲突屏本身。
//
// 需要躲避时，排除目标恒等于本 tick 的 conflictDisplayId。
//
// ⚠️ 不要把调用方的跟踪值（悬浮窗的 overlayDodgeSourceDisplayId / 聊天窗口的
// dodgeDisplayId，均为上一 tick 遗留值）接进这个函数当参数、更不要拿它参与排除目标的计算
// （例如写成 trackedDisplayId ?? conflictDisplayId）——那正是 review finding A 的回归：
// 冲突中途换屏后排除项过期，displays.find(d => d.id !== 过期值) 会解回本窗口当前已在的
// 那块屏，跳屏变成 no-op，本窗口永久卡在冲突之上。排除目标必须永远来自本 tick 最新的
// conflictDisplayId。本函数刻意保持无状态、不接收任何跟踪值，正是为了让上面这种写法
// 没有落脚点。
//
// 本函数是窗口无关的纯函数（只吃显示器 id/布尔值），同时供 handleOverlayDodge（悬浮窗）与
// handlePinMode（聊天窗口的 dodge-fullscreen 分支）复用——两者判断"是否被遮挡、该躲去哪"
// 的逻辑完全相同，区别只在各自的跟踪变量与要不要"跳不出去就让位"（聊天窗口独有，见
// handlePinMode）
export type DodgeDecision = { action: 'dodge'; excludeDisplayId: number } | { action: 'none' }

export function decideDodge(
  needsToDodge: boolean,
  isWhitelisted: boolean,
  ownDisplayId: number,
  conflictDisplayId: number
): DodgeDecision {
  if (!needsToDodge || isWhitelisted) return { action: 'none' }
  if (ownDisplayId !== conflictDisplayId) return { action: 'none' }
  return { action: 'dodge', excludeDisplayId: conflictDisplayId }
}

// handleOverlayDodge/handlePinMode 判断"这一 tick 报告的前台窗口不需要躲避时，该不该
// 结束当前躲避 episode（清掉跟踪状态 + 把当前屏幕采纳为下次启动的家）"的纯函数部分，跟
// shouldSkipOverlayDodge/decideDodge 同一个理由抽出来单测。
//
// 清账只由"是否还欠着一次躲避账"（trackedDisplayId !== null）单独决定，跟前台窗口此刻在
// 哪块屏幕完全无关。悬浮窗的旧代码在这里要求 info.displayId === overlayDodgeSourceDisplayId
// 才清账（历史原因见 handleOverlayDodge 调用点上方的注释：清账当年会连带触发
// restoreToDisplay 把悬浮窗拖回"家"，需要"家已经空出来了"的证据，而"前台窗口此刻就落在家
// 那块屏幕上"是唯一能拿到的证据）；restoreToDisplay 先是从这条路径移除，后来该函数本身
// 也随聊天窗口那条镜像路径的同一收尾（见 endDodgeEpisodeIfLeavingDodgeMode）被整体删除，
// 那道门槛的存在依据也随之消失。聊天窗口的 handlePinMode 曾经也有同一形状的门槛
// （"问题1b"，见该分支历史注释），依据同样已经不成立，改用同一个函数清账。
//
// ⚠️ 本函数刻意只收一个参数，不接收前台窗口所在的显示器——这跟 decideDodge 刻意
// 不收跟踪值是同一手法：让"把那道显示器比较加回来"在签名里没有落脚点。曾经试过反向做法
// （多收一个用不到的 foregroundDisplayId 当钩子，靠单测拦），review 指出那是**更弱**的
// 保护：参数在场时，加回比较只是同一签名下的一行函数体修改，签名不变、调用点不动，没有
// 任何东西迫使人重新读一遍这段注释；参数不在场时，必须先给一个导出函数加参数，那是一次
// 会连带改调用点、必然形成 diff hunk 的签名变更。因此不要为了"方便测回归"把它加回来——
// 两个调用方（悬浮窗/聊天窗口）各自传各自的跟踪值即可，不需要、也不应该给这个函数增加
// 第二个参数去区分"是哪个窗口在问"
export function decideDodgeClear(trackedDisplayId: number | null): boolean {
  return trackedDisplayId !== null
}

// 悬浮窗躲避逻辑。activeWindowMonitor 直接回传前台冲突窗口所在的 displayId（该字段在
// ActiveWindowInfo 非空时必已解析，见该文件类型定义处注释）——躲避判断以它为准：只有
// 悬浮窗自己当前所在的显示器与这个冲突显示器一致时才算被遮挡，需要挪走；冲突发生在别的
// 屏幕上时悬浮窗原地不动，具体判断与排除目标的选择见 decideDodge
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
  // 交给 animateTo 自己的取消/重开逻辑处理，本来就是安全的）——更重要的是下面每个 tick
  // 判断"悬浮窗是否被这次冲突遮挡"都要现读 screen.getDisplayMatching(overlayWindow
  // .getBounds()) 拿悬浮窗当前所在的显示器，动画进行中读 getBounds() 可能读到半路的位置，
  // 把 getDisplayMatching 判断成错误的显示器——可能误判成"没有遮挡"而漏挪，也可能误判成
  // "被遮挡"而挪错方向。isAnimating(overlayWindow) 只查悬浮窗自己是否在动画中——聊天窗口
  // 现在可能同一 tick 独立动画，不再是共享单飞状态，因此这里不会因为聊天窗口在动而被
  // 连带跳过
  if (isAnimating(overlayWindow)) return

  // 黑名单单独也算"必须躲避"（不要求同时全屏）：黑名单的语义是"这个程序不全屏也不能被
  // 悬浮窗盖住"，跟全屏走同一个分支
  const needsToDodge = info.isFullscreen || (info.exeName !== null && includesIgnoreCase(cachedConfig.blacklist, info.exeName))
  const isWhitelisted = info.exeName !== null && includesIgnoreCase(cachedConfig.fullscreenWhitelist, info.exeName)

  if (needsToDodge && !isWhitelisted) {
    const overlayDisplayId = screen.getDisplayMatching(overlayWindow.getBounds()).id
    const decision = decideDodge(needsToDodge, isWhitelisted, overlayDisplayId, info.displayId)
    if (decision.action === 'dodge') {
      // 每个 tick 都无条件同步成本 tick 的冲突显示器（decision.excludeDisplayId 恒等于
      // info.displayId，见 decideDodge）——不再只在 === null 时赋值一次，见上方
      // overlayDodgeSourceDisplayId 声明处"曾经的缺陷②"：冲突中途换屏时，旧的一次性赋值
      // 会让排除项过期。
      //
      // 这个变量现在只有一个消费方——decideDodgeClear 判断"是否还欠着一次躲避账"
      // （trackedDisplayId !== null），不再关心它具体记的是哪块显示器，因此"冲突中途换屏
      // 导致这个值不再等于最初进入躲避那一刻的显示器"不会造成任何问题（历史上"冲突已解除"
      // 分支曾经会拿它跟前台窗口所在的显示器比较，那道比较已经在本轮改动中移除，见该分支
      // 注释）
      overlayDodgeSourceDisplayId = decision.excludeDisplayId
      // moveToNonFullscreenDisplay 现在完全自己查表/算默认值（见该函数注释），不再需要
      // 调用方传入现场读数当基准
      const moved = moveToNonFullscreenDisplay(overlayWindow, 'overlay', decision.excludeDisplayId)
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
      // 冲突发生在悬浮窗所在屏幕之外——没有被这次冲突遮挡，这一 tick 不挪动位置（既不
      // 跳屏，也不重新计算/覆盖 overlayDodgeSourceDisplayId：若正在追踪另一次躲避，保持
      // 追踪值不变）。可见性仍按 chatFocused 门控兜底显示，理由跟下面"冲突已解除"分支
      // 尾部的可见性守卫一致（同函数头注释的 BLOCKER）：聊天窗口失焦没有一次性事件通知
      // 这里，需要每个 tick 都重新判断
      if (!overlayWindow.isVisible() && !chatFocused) {
        overlayWindow.showInactive()
      }
    }
  } else {
    // 问题1b 的历史（记录，不是现行逻辑）：这道"前台窗口是否落在家那块屏幕上"的门槛曾经
    // 存在，是因为当年清账会连带调用 restoreToDisplay，把悬浮窗拖回冲突前所在的"家"——那个
    // 归位动作只有在"家"确实空出来了才安全，而"前台窗口此刻恰好落在家那块屏幕上"是唯一能
    // 拿到的证据（activeWindowMonitor 一次只报告一个前台窗口）。restoreToDisplay 先是从
    // 这条路径被移除——清账变成原地不动 + 记账（见下面 setLastDisplayId 那两行），不再归位，
    // 这道门槛的存在依据随之消失，当时它唯一还剩的效果是拖住/挡住清账本身。该函数本身后来
    // 又随聊天窗口切走 dodge-fullscreen 模式那条镜像路径的同一收尾被整体删除，见
    // endDodgeEpisodeIfLeavingDodgeMode 注释。
    //
    // 而且这道门槛在跨屏 episode 里已经不可能稳定命中：overlayDodgeSourceDisplayId 现在
    // 每个 tick 都刷新成当前冲突所在的显示器（见该变量声明处"曾经的缺陷②"），若冲突在
    // episode 中途换过屏、又在换到的新屏幕上解除，前台窗口这一刻大概率不在
    // overlayDodgeSourceDisplayId 记的那块屏上——比较永远不命中：setLastDisplayId 被跳过
    // （下次启动的"家"沿用一块用户早已离开的旧屏幕），overlayDodgeSourceDisplayId 也永远
    // 清不掉（连带让 isDodgeParked('overlay') 卡在 true，永久压住悬浮窗位置持久化，见该
    // 函数注释）。
    //
    // 现在的条件：走到这个 else 分支本身就已经意味着"这一 tick 不需要为当前前台窗口躲避"
    // （要么不是全屏/黑名单，要么在白名单里）——这就是冲突解除的全部证据，不需要也不应该
    // 再额外核对前台窗口在哪块屏幕。是否结束 episode 只取决于"此刻是否还欠着一次躲避账"
    // （overlayDodgeSourceDisplayId !== null，语义见 shouldSkipOverlayDodge 注释）。抽成
    // decideDodgeClear 纯函数并单测，钉住"不做显示器比较"这一点，防止这道门槛被
    // 悄悄加回来（见该函数头注释）。
    //
    // 执行顺序也从"先清账、再兜底显示"改成"先兜底显示、再清账"：
    // overlayDodgeSourceDisplayId !== null 的真正含义是"我因为躲避把这个悬浮窗藏起来/挪走
    // 过，还欠它一次重新显示"（shouldSkipOverlayDodge 正是靠这个语义才能在"隐藏但仍在追踪"
    // 时放行）——先兑现这笔债，再清掉记账，就不会存在"账已经清了、但还没补显示"的一 tick
    // 空窗。showInactive() 不移动窗口，不影响下面 setLastDisplayId 要读的
    // getBounds()，两步顺序对调是安全的。
    //
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
    // chatFocused 守卫则两支都要加，同一个理由：冲突解除的这一刻，如果聊天窗口恰好持有
    // 焦点，仍然不能把悬浮窗重新显示出来（同函数头注释的 BLOCKER）。
    //
    // 已知遗留（记录，不在本轮修复范围内）：如果 episode 恰好是在 chatFocused === true 时
    // 解除的，上面这一步会跳过、悬浮窗保持隐藏，下面仍然照常清账——这是刻意的，此刻的可见性
    // 归"聊天窗口持有焦点时收起悬浮窗"这条规则管，不是这次躲避欠的账。但如果用户之后把焦点
    // 从聊天窗口移到某个第三方窗口、且没有先最小化/关闭聊天窗口，没有任何路径会重新显示
    // 悬浮窗：账已经清空，下一次 tick 会在 shouldSkipOverlayDodge(false, null) 处直接短路
    // 整个函数；而 index.ts 里聊天窗口只注册了 'focus'（隐藏悬浮窗）/'minimize'/'close'
    // （显示悬浮窗）三个监听，没有 'blur' 去触发"重新评估悬浮窗是否还需要隐藏"。这是
    // index.ts 现有监听集合本身的缺口，早于本次改动就存在，不是这里引入的回归，不在本轮
    // 修复范围。
    //
    // ⚠️ 但要如实记一笔暴露面的变化：本轮之前，这条清账路径因为那道 问题1b 门槛在跨屏
    // episode 里几乎命中不了（正是本轮修的 bug），所以上面这个组合在实际使用中很罕见；
    // 本轮让清账变成每个 episode 都可靠触发，这个遗留因此变得明显更容易碰到。缺口本身
    // 不是新的，可达性是新的——真要收口，该做的是给 index.ts 补 'blur' 监听，那是独立一件事
    if (!overlayWindow.isVisible() && !chatFocused) {
      overlayWindow.showInactive()
    }
    if (decideDodgeClear(overlayDodgeSourceDisplayId)) {
      setLastDisplayId('overlay', screen.getDisplayMatching(overlayWindow.getBounds()).id)
      overlayDodgeSourceDisplayId = null
    }
  }
}

// 聊天窗口置顶逻辑的"冲突态"记录：只保留 dodgeDisplayId——当前已知的冲突（全屏应用）
// 所在的显示器 id，来自 ActiveWindowInfo.displayId，每个 tick 在仍处于躲避状态时都会
// 刷新（见 handlePinMode 的 decision.action === 'dodge' 分支），不是"进入冲突那一刻"的
// 一次性快照。不再额外维护一份捕获的坐标（旧版本的 homeBounds），理由跟
// overlayDodgeSourceDisplayId 同（查表设计下跳屏目标都改由 moveToNonFullscreenDisplay
// 现查持久化表；归位目标这一侧原本由 restoreToDisplay 现查同一张表，该函数已随下方
// endDodgeEpisodeIfLeavingDodgeMode 改为"原地不动 + 记账"而整体删除，见其注释）。
//
// 曾经的缺陷①（用户报告）：这里错误地记录成"聊天窗口自己当时所在的显示器 id"
// （screen.getDisplayMatching(mainWindow.getBounds())），且只在 === null 时赋值一次、
// 此后固定不变——这个值只在第一次跳屏那一刻恰好等于冲突所在的显示器（聊天窗口还没挪走）。
// 第二次全屏冲突发生在聊天窗口刚跳去的目标屏上时，过期的排除项会让
// moveToNonFullscreenDisplay 把聊天窗口反而排到当前的全屏冲突屏本身——跟
// overlayDodgeSourceDisplayId 声明处记录的"曾经的缺陷①②"是同一类问题，现在同样改为
// 采用 ActiveWindowInfo.displayId 并每 tick 刷新。不要用"聊天窗口自己当前所在的显示器"
// 重新计算这个跟踪值/排除项来源——那正是曾经的缺陷①，会在双屏环境下让聊天窗口在两块
// 屏幕之间反复横跳
let dodgeDisplayId: number | null = null

// 切换到非 dodge-fullscreen 模式时，如果聊天窗口当下正卡在跳屏后的位置（dodgeDisplayId
// 有值），必须结束这次跳屏 episode——否则用户在跳屏躲避期间把置顶模式切成"关闭"或"绝对
// 置顶"，dodgeDisplayId 会变成没人再清理的孤儿状态，置顶态也不会校正到新模式该有的样子。
//
// P-2 已经把"冲突自然解除"那条路径（handlePinMode 最后 else 分支里的清账）从"飞回冲突前
// 所在的那块屏"改成"原地不动 + 把当前屏幕采纳为家 + 清账"——理由是那次归位飞的正是刚刚
// 全屏过的那块屏，聊天窗口此刻已经稳定停在跳屏目标屏（一块没有冲突的好屏幕）上，飞回去
// 没有必要，只会制造一次可见的"飞回"（用户报告的原话，见 handlePinMode 分支注释里的
// "缺陷③"）。用户切走 dodge-fullscreen 模式这条路径此前一直是例外——仍然调用
// restoreToDisplay 飞回 dodgeDisplayId。但同一个论证在这里逐字成立：飞回去的目标同样是
// "曾经的冲突屏"，聊天窗口此刻同样已经稳定停在跳屏目标屏上，飞回去同样只会制造一次不必要
// 的可见"飞回"。现在改为跟自然解除完全一致的处理——原地不动，把当前所在的显示器采纳为
// 下次启动的家（setLastDisplayId），再清掉追踪状态。这也让 dodgeDisplayId 不再需要承担
// "冲突解除时飞回的目标"这个角色，只单纯充当"是否还欠着一次躲避账"的追踪标记，两条收尾
// 路径不再各自维护一份不同的语义——这也是本轮改动之前"dodgeDisplayId 双重角色"这个
// 架构冲突的根源，改到这里之后冲突随之消失：不再存在任何需要保持稳定的"家"值，上面
// decision.action === 'dodge' 分支每 tick 刷新 dodgeDisplayId（修跳屏目标 bug 所需）
// 因此也不再跟任何东西对立。
//
// 两个调用点：① handlePinMode 每个 tick 都会经过这里（覆盖"轮询过程中前台窗口切换、
// 顺带发现 pinMode 也变了"这种情况）；② updateCachedWindowBehaviorConfig 在配置真正
// 改变的那一刻立即调用一次——这一条是必须的，不能只依赖①：用户改这个设置通常是在设置页/
// 托盘菜单里操作，那一刻前台窗口就是 MintBot 自己，activeWindowMonitor 会因为自我排除
// 返回 null，handleActiveWindowChange 整个短路，handlePinMode 根本不会被调用，若只有①，
// 结束 episode 会一直拖到用户下一次切到某个外部窗口才触发
// 重试的轮询间隔：仅用于"当前正有一段跳屏动画在飞"这一种情形下的短暂等待，不是给这个
// 函数常态使用的节奏。500ms 的三段式动画（EXIT_DURATION_MS + ENTRANCE_DURATION_MS，见
// windowAnimation.ts）跑完之前，isAnimating(mainWindow) 恒为 true；选一个明显小于该总时长
// 的固定间隔重新检查，而不是一次性等满整个时长再查——等待期间随时可能又有新一轮动画被
// 触发（比如一次跳屏还没飞完），固定短间隔能在下一次机会窗口里发现它仍在动，不用赌一次
// 时长刚好够
const RESTORE_RETRY_MS = 60

// 本函数已经不再"归位"（不再飞回任何显示器），只结束当前跳屏 episode——原地不动 + 把当前
// 显示器采纳为家 + 清账，跟 handlePinMode 里"冲突自然解除"那条路径完全一致（见上方大段
// 注释）。沿用旧名字 restoreHomeBoundsIfLeavingDodgeMode 会名不副实，因此改名
function endDodgeEpisodeIfLeavingDodgeMode(mainWindow: BrowserWindow, pinMode: PinMode): void {
  if (pinMode !== 'dodge-fullscreen' && dodgeDisplayId !== null) {
    // 本函数有三个调用点：handlePinMode 每个 tick 无条件调一次（轮询驱动），以及
    // updateCachedWindowBehaviorConfig / initWindowBehaviorConfig 在配置变更/冷启动那一刻
    // 各调一次（均非轮询驱动、不会自动重试）。三者都可能撞上"聊天窗口这一刻正有一段跳屏
    // 动画在飞"。
    //
    // 这条 isAnimating(mainWindow) 守卫的原始理由（避免撞上 restoreToDisplay 的动画产生
    // snap-then-refly 闪烁）已经随 restoreToDisplay 一并消失——本函数现在不再挪动窗口，
    // 没有动画可撞。但守卫本身仍然必须保留，理由换成了另一件事：下面 setLastDisplayId 要
    // 读 screen.getDisplayMatching(mainWindow.getBounds())，若这一刻跳屏动画还在飞，
    // getBounds() 读到的是补间途中的半路坐标——落在哪块显示器纯属巧合，会把错误的显示器
    // 记成"家"。这跟 handleOverlayDodge 顶部那条 isAnimating(overlayWindow) 守卫是同一个
    // 理由（该函数同样要等动画结束、getBounds() 落到最终位置之后才能安全读显示器），见
    // 其调用点上方的注释。
    //
    // 这里不能简单地整体跳过这次调用——handlePinMode 的轮询路径尚有"下一次前台窗口变化"
    // 兜底，但 updateCachedWindowBehaviorConfig/initWindowBehaviorConfig 是一次性调用，
    // 跳过之后不保证短时间内还有别的路径会再次触发同一次结束检查，dodgeDisplayId 会一直
    // 悬着，episode 永远结不了账。改成短延迟后重新调用自己，而不是直接丢弃——dodgeDisplayId
    // 在等待期间保持不变（未清空），结束请求本身没有丢失，只是推迟到动画结束后的下一次
    // 检查；重试时重新读 cachedConfig.pinMode 而不是复用这次调用捕获的参数，防止等待
    // 期间配置又变了一次、拿着过期判断结果误结束或误跳过
    if (isAnimating(mainWindow)) {
      setTimeout(() => {
        if (!mainWindow.isDestroyed()) endDodgeEpisodeIfLeavingDodgeMode(mainWindow, cachedConfig.pinMode)
      }, RESTORE_RETRY_MS)
      return
    }
    // 结束这次跳屏 episode 的同时要把置顶态也校正到新模式该有的样子——这个函数现在有两个
    // 调用点：handlePinMode 里紧跟着的 'off'/'always-on-top' 分支会自己调
    // setAlwaysOnTop，但 updateCachedWindowBehaviorConfig 是独立调用，没有后续分支兜底，
    // 不在这里一并处理的话，跳屏期间已经生效的 setAlwaysOnTop(true) 会一直卡住，直到下
    // 一次切到外部窗口触发轮询路径才被动更正——走 applyAlwaysOnTop 本身就是幂等的，不影响
    // handlePinMode 那边紧接着再调一次。必须在 dodgeDisplayId = null 之前调用
    // （discharge-before-clear，跟下面 setLastDisplayId 同样发生在清空之前）
    applyAlwaysOnTop(mainWindow, pinMode === 'always-on-top')
    // 原地不动，不再飞回 dodgeDisplayId——把当前所在的显示器采纳为下次启动的家，跟
    // handlePinMode 里"冲突自然解除"分支的收尾完全一致，见上方大段注释
    setLastDisplayId('chat', screen.getDisplayMatching(mainWindow.getBounds()).id)
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

  endDodgeEpisodeIfLeavingDodgeMode(mainWindow, pinMode)

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
  // 冲突/躲避判断改为跟悬浮窗躲避共用同一套（decideDodge，见其头注释）：是否存在冲突用
  // needsToDodge = info.isFullscreen（不核对黑名单——黑名单只在悬浮窗躲避逻辑里生效，
  // 见 §3.7 附「z-order 竞争规则」的已知缺口，dodge-fullscreen 本轮不新增消费它）；是否
  // 需要为这次冲突躲避额外要求聊天窗口自己当前所在的显示器与冲突所在的显示器
  // （info.displayId）一致——冲突发生在别的屏幕上时聊天窗口毫无遮挡，不该动它。
  //
  // 曾经的说法（已删除，如实记录为错误结论，不是这次改动引入的问题）：这里曾经声称
  // activeWindowMonitor 只回传 isFullscreen/exeName/title、没有前台窗口的原始矩形，
  // "没法反查它具体在哪块显示器"，因此索性不做这层比较、逢全屏必跳。这个说法是错的——
  // ActiveWindowInfo.displayId 字段本就存在，且在 info 非空时必已解析（见
  // activeWindowMonitor.ts 类型定义处的注释），悬浮窗躲避一直依赖的正是同一个字段。单屏
  // 场景下这个简化确实不可观察（只有一块屏幕，"跟聊天窗口不同屏"这个分支永远不成立），
  // 但多屏下会导致全屏发生在聊天窗口所在屏幕之外时也无差别跳屏。
  //
  // 上一轮跳屏动画还没结束时整个 dodge-fullscreen 分支这一 tick 都跳过——不只是下面的
  // dodge 分支需要它：最后 else 分支的清账同样会读 mainWindow.getBounds() 算
  // setLastDisplayId 的落点，若这一刻窗口仍在飞（比如上一个 tick 触发的跳屏动画还没播完），
  // 读到的会是半路位置。之前这条守卫只挂在 inContention 内部，三段式改造把总时长从 180ms
  // 拉到 500ms 之后这类竞态窗口明显更容易被撞上，因此把守卫提到整个 dodge-fullscreen 分支
  // 最前面（跟 handleOverlayDodge 的守卫放在整个函数最前面是同一个约定）。
  //
  // 提到这里不会漏掉"每 tick 都必须做"的事：'off'/'always-on-top' 分支已经在上面 return
  // 过，不受影响；下面无冲突/冲突已解除的 else 分支只调用幂等的 applyAlwaysOnTop(true)，
  // 被这次跳过延后一个 tick 无害——已核实 isAnimating(mainWindow) 为真时必然是本文件的
  // 跳屏流程正在跑（唯一会对 mainWindow 调用 animateTo 的调用点就是
  // moveToNonFullscreenDisplay，只在 dodgeDisplayId 有值时触发），因此这一刻
  // dodgeDisplayId 不可能是 null，else 分支实际上不会被这条守卫拦到。
  if (isAnimating(mainWindow)) return

  const isWhitelisted = info.exeName !== null && includesIgnoreCase(fullscreenWhitelist, info.exeName)
  const needsToDodge = info.isFullscreen

  if (needsToDodge && !isWhitelisted) {
    const ownDisplayId = screen.getDisplayMatching(mainWindow.getBounds()).id
    const decision = decideDodge(needsToDodge, isWhitelisted, ownDisplayId, info.displayId)

    if (decision.action === 'dodge') {
      // 每个 tick 都无条件同步成本 tick 的冲突显示器（decision.excludeDisplayId 恒等于
      // info.displayId，见 decideDodge），不再只在 dodgeDisplayId === null 时赋值一次。
      //
      // 缺陷①（用户报告）：旧代码只在 === null 时用"聊天窗口自己当前所在的显示器"
      // （screen.getDisplayMatching(mainWindow.getBounds())）播下这个值，此后固定不变——
      // 这个值只在第一次跳屏那一刻恰好等于冲突所在的显示器（聊天窗口还没挪走）。第二次
      // 全屏冲突发生在聊天窗口刚跳去的那块目标屏上时，dodgeDisplayId 仍是过期的第一块屏，
      // moveToNonFullscreenDisplay 的 displays.find(d => d.id !== 过期值) 反而会把聊天
      // 窗口排到当前的全屏冲突屏本身——跟 overlayDodgeSourceDisplayId 曾经的缺陷②
      // （见该变量声明处注释）是同一类回归，现在同样改为每 tick 用最新的 info.displayId
      // 覆盖，让排除项恒等于"最新已知的冲突显示器"
      dodgeDisplayId = decision.excludeDisplayId
      // moveToNonFullscreenDisplay 现在完全自己查表/算默认值（见该函数注释），不再需要
      // 调用方传入现场读数当基准
      const moved = moveToNonFullscreenDisplay(mainWindow, 'chat', decision.excludeDisplayId)
      // P-2：dodge-fullscreen 的语义改为"常驻置顶 + 遇全屏跳屏"。跳成功后聊天窗口已经不
      // 跟全屏应用共享同一块屏幕，置顶不再构成遮挡，继续置顶才是用户预期的默认体验（等价
      // 于非冲突场景下的悬浮置顶）
      if (moved) {
        applyAlwaysOnTop(mainWindow, true)
      } else {
        // 单屏，或所有显示器都被排除项排除（找不到可跳的目标屏幕）：跳不出去，就没有
        // "挪开位置来避免遮挡"这条路可走，dodge-fullscreen 的目的本来就是不遮挡全屏
        // 内容，跳屏只是首选手段，跳不了时唯一还能兑现这个目的的办法是让位——取消置顶，
        // 允许全屏应用（游戏/播放器）盖住聊天窗口，而不是死扛置顶。这里必须显式求值为
        // false 传给 applyAlwaysOnTop，不能不调用指望它维持原样：P-2 之后非冲突态的
        // 基线已经是"置顶"，进入这次冲突之前 alwaysOnTop 大概率已经是 true，不显式取消
        // 的话它会一直卡在 true 直到冲突解除才被下面 else 分支纠正回来，等同于单屏下这个
        // 模式又退化回"从不让位"
        applyAlwaysOnTop(mainWindow, false)
      }
    } else {
      // decision.action === 'none'：存在全屏冲突，但它跟聊天窗口自己当前所在的显示器
      // 不是同一块——缺陷②（用户报告）：旧代码没有这层比较，逢全屏必跳，哪怕全屏发生在
      // 聊天窗口所在屏幕之外。现在正确判定为"没有被这次冲突遮挡"，原地不动、也不改动
      // dodgeDisplayId（若正躲避追踪中，保持追踪值不变，供下一次真正需要重新躲避时使用；
      // 若从未冲突过，dodgeDisplayId 本就是 null）。置顶态套用幂等的 applyAlwaysOnTop
      // (true)——这块屏幕本来就没有全屏应用挡住聊天窗口，该置顶
      applyAlwaysOnTop(mainWindow, true)
    }
  } else {
    // 无冲突（不是全屏），或在白名单里：P-2 之后 dodge-fullscreen 平时的表现跟
    // always-on-top 一致——常驻置顶，区别只在遇到全屏冲突时会跳屏（跳不了时让位，见上面
    // decision.action === 'dodge' 分支）
    applyAlwaysOnTop(mainWindow, true)

    // 缺陷③（用户报告，"问题1b"门槛的移除）：清账（结束跳屏 episode）此前要求
    // info.displayId === dodgeDisplayId（前台窗口确实落在"家"那块屏幕上）才认定冲突解除，
    // 历史依据是清账当年会连带调用 restoreToDisplay 把聊天窗口拖回"家"，需要"家已经空出
    // 来了"的证据——那次归位调用后来被移除（见下面 setLastDisplayId 这两行的注释：现在只
    // 原地记账，不归位）；restoreToDisplay 这个函数本身后来又随聊天窗口切走 dodge-fullscreen
    // 模式那条镜像路径的同一收尾被整体删除，见 endDodgeEpisodeIfLeavingDodgeMode 注释。
    // 门槛的存在依据随之消失，只剩下"拖住清账本身"这一个效果。且这道门槛
    // 在跨屏 episode 里已经不可能稳定命中：dodgeDisplayId 现在每个 tick 都刷新成当前冲突
    // 所在的显示器（见上面 decision.action === 'dodge' 分支的注释），若冲突中途换过屏、
    // 又在新屏幕上解除，前台窗口这一刻大概率不在 dodgeDisplayId 记的那块屏上——比较永远
    // 不命中，dodgeDisplayId 永远清不掉。改用跟悬浮窗共用的 decideDodgeClear：清账只由
    // "是否还欠着一次躲避账"（dodgeDisplayId !== null）决定，不再做任何显示器比较。
    //
    // 执行顺序：先补上面的 applyAlwaysOnTop(mainWindow, true)（欠账——若上一个 tick 因为
    // 跳不出去而让位过，alwaysOnTop 此刻是 false，必须先恢复成 true），再清掉追踪状态，
    // 不能反过来——applyBaselinePinMode（配置变更/冷启动的调用点）用 dodgeDisplayId
    // === null 判断"没有遗留的冲突时决策需要保留、可以放心套用基线"，若 dodgeDisplayId
    // 先变回 null、置顶还没来得及恢复，两次调用之间会出现一个短暂但真实的、本该置顶却
    // 没有置顶的空档
    if (decideDodgeClear(dodgeDisplayId)) {
      setLastDisplayId('chat', screen.getDisplayMatching(mainWindow.getBounds()).id)
      dodgeDisplayId = null
    }
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
