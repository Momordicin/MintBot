import { BrowserWindow, screen } from 'electron'
import type { ActiveWindowInfo } from './activeWindowMonitor'

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
// index.ts createOverlayWindow() 里贴右下角的坐标算法，但参数化成"目标显示器"+"窗口自身
// 当前尺寸"（win.getBounds() 而非硬编码的 OVERLAY_WIDTH/HEIGHT 常量），因为这个工具函数
// 同时服务于悬浮窗和聊天窗口两种不同尺寸的窗口。找不到替代显示器（单屏，或所有屏幕都被
// 排除）时返回 false，由调用方决定接下来怎么处理（隐藏悬浮窗 / 聊天窗口原地不动）
export function moveToNonFullscreenDisplay(win: BrowserWindow, excludeDisplayId: number): boolean {
  const target = screen.getAllDisplays().find(display => display.id !== excludeDisplayId)
  if (!target) return false

  // 用 workArea（带 x/y 偏移）而不是 workAreaSize：任务栏停靠在上边/左边时 workArea.x/y
  // 不为 0，只用宽高算出来的坐标会跟任务栏厚度错位——跟 createOverlayWindow 的注释同理
  const { x: workAreaX, y: workAreaY, width: workAreaWidth, height: workAreaHeight } = target.workArea
  const { width, height } = win.getBounds()
  win.setBounds({
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
// （排除 B 找到 A，下一 tick 排除 A 又找回 B）
let overlayDodgeSourceDisplayId: number | null = null

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
    if (overlayDodgeSourceDisplayId === null) {
      overlayDodgeSourceDisplayId = screen.getDisplayMatching(overlayWindow.getBounds()).id
    }
    const moved = moveToNonFullscreenDisplay(overlayWindow, overlayDodgeSourceDisplayId)
    if (moved) {
      overlayWindow.showInactive()
    } else {
      // 没有别的屏幕可跳（单屏，或全部屏幕都是同一块）：直接隐藏，不能留在原地盖住全屏/
      // 黑名单程序
      overlayWindow.hide()
    }
  } else {
    // 不需要躲避（含"需要躲避但在白名单里，白名单胜出"），重置躲避状态并在当前/默认位置显示，
    // 不强制挪回悬浮窗原始位置——悬浮窗躲避后没有类似聊天窗口 homeBounds 的"归位"机制，
    // 这是计划文档描述的既有简化，不在本次任务范围内新增
    overlayDodgeSourceDisplayId = null
    overlayWindow.showInactive()
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
    mainWindow.setBounds(homeBounds)
    // 归位的同时要把置顶态也校正到新模式该有的样子——这个函数现在有两个调用点：
    // handlePinMode 里紧跟着的 'off'/'always-on-top' 分支会自己调 setAlwaysOnTop，
    // 但 updateCachedWindowBehaviorConfig 是独立调用，没有后续分支兜底，不在这里
    // 一并处理的话，跳屏期间已经生效的 setAlwaysOnTop(true) 会一直卡住，直到下一次
    // 切到外部窗口触发轮询路径才被动更正——重复这行本身是幂等的，不影响 handlePinMode
    // 那边紧接着再调一次
    mainWindow.setAlwaysOnTop(pinMode === 'always-on-top')
    homeBounds = null
    dodgeDisplayId = null
  }
}

// 聊天窗口置顶逻辑（!chatIsHidden 时走这支），按 pinMode 三选一分支
function handlePinMode(info: ActiveWindowInfo, mainWindow: BrowserWindow): void {
  const { pinMode, fullscreenWhitelist } = cachedConfig

  restoreHomeBoundsIfLeavingDodgeMode(mainWindow, pinMode)

  if (pinMode === 'off') {
    mainWindow.setAlwaysOnTop(false)
    return
  }

  if (pinMode === 'always-on-top') {
    mainWindow.setAlwaysOnTop(true)
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
    const moved = moveToNonFullscreenDisplay(mainWindow, dodgeDisplayId as number)
    if (moved) {
      mainWindow.setAlwaysOnTop(true)
    }
    // 找不到非全屏屏幕（所有屏幕都全屏）：原地不动、不设置置顶——不抢占已经全屏的屏幕
  } else if (homeBounds !== null) {
    // 冲突解除：归位 + 取消置顶 + 清掉记录
    mainWindow.setBounds(homeBounds)
    mainWindow.setAlwaysOnTop(false)
    homeBounds = null
    dodgeDisplayId = null
  } else {
    // 从未冲突过：确保取消置顶（幂等，已经是 false 时无副作用）
    mainWindow.setAlwaysOnTop(false)
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
