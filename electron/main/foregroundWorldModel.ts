import { probeBlockerWindow, getActiveWindowInfo } from './activeWindowMonitor'
import type { ForegroundObservation } from './activeWindowMonitor'
import { getWindowBehaviorRules } from './windowBehavior'
import { applyExternalObservation, validateBlockers } from './displayStateMap'
import type { DisplayStateMap, ValidationMode } from './displayStateMap'
import { isAnyDragInProgress } from './dragActivity'

// Stage 1：把 activeWindowMonitor.ts 的观察流与 displayStateMap.ts 的纯逻辑接起来的薄编排
// 层——本文件是本次改动里唯一持有可变模块状态的地方，Win32/Electron 相关的副作用（探测、
// 定时器）都在这里发生，决策逻辑本身仍然全部委托给 displayStateMap.ts 的纯函数。
//
// Stage 2：决策层（electron/main/windowBehavior.ts 的 evaluatePetPresence/
// evaluateChatPresence）现在直接读本文件的 getDisplayStateMap()，取代了 Stage 1 时"只建立/
// 维护、没有任何消费方"的状态。本文件自己不知道决策层是谁、也不直接调用它——
// startBlockerValidationLoop 的 onValidated 回调与 index.ts 里 500ms 前台轮询回调各自的
// "地图更新后重新 evaluate 一次"调用，都由 index.ts 接线，本文件只负责"地图变了"这件事
// 本身，保持它不依赖 windowBehavior.ts 之外的任何决策概念（现有的 getWindowBehaviorRules
// 依赖是纯配置读取，不是决策）

let displayStateMap: DisplayStateMap = new Map()

// Stage 2 起由 windowBehavior.ts 的 evaluatePetPresence/evaluateChatPresence 读取，作为
// resolver 的输入；此前（Stage 1）只供排查/单测读取，没有任何决策消费方
export function getDisplayStateMap(): DisplayStateMap {
  return displayStateMap
}

// 每次 activeWindowMonitor 报告一次新的前台观察时调用一次。self/unavailable 两种观察都不
// 建立/刷新任何东西——不会调用 applyExternalObservation，displayStateMap 这个引用原样不变，
// 这也是"self/unavailable 清不掉任何东西"这条要求在编排层的落地点（displayStateMap.ts 的
// applyExternalObservation 本身只认 ExternalWindowInfo，从类型上就不接受另外两种观察）
export function updateDisplayStateMap(observation: ForegroundObservation): void {
  if (observation.kind !== 'external') return
  displayStateMap = applyExternalObservation(displayStateMap, observation.info, getWindowBehaviorRules())
}

// Fix 3（ts-backend-reviewer/integration-reviewer rework）：从"世界模型此刻掌握的两个独立
// 信号"里选出校验模式，抽成纯函数单独测——runValidationPass 本身依赖 getActiveWindowInfo()/
// isAnyDragInProgress() 两个有副作用的读取，不适合直接单测，跟 windowPositions.ts/
// windowAnimation.ts 头部注释同一套"纯逻辑单独抽出来测"的约定。
//
// 根因不是"正在拖拽"，而是"MintBot 自己此刻占着前台"——点击/拖拽任一窗口都会让 Windows
// 把前台焦点从原本全屏的程序那里抢过来，使它瞬间读到 isFullscreen = false。Stage 3 起
// isAnyDragInProgress()（electron/main/dragActivity.ts，second rework pass 起改为跨窗口聚合
// isWindowDragInProgress，见该文件头部注释）由 WM_ENTERSIZEMOVE/
// WM_EXITSIZEMOVE 这对权威信号驱动（electron/main/windowDragMonitor.ts），WM_ENTERSIZEMOVE
// 在鼠标按下、尚未产生任何 'moved' 事件时就已经触发，此前"由 noteUserDragActivity 驱动、只在
// 第一个 moved 到达之后才为真"的那段空窗期已经随之关闭。但它只覆盖"正在拖拽"这一种触发
// 方式——MintBot 占着前台不止拖拽这一条路径（例如只是点击了聊天窗口里的一个按钮，从未进入
// WM_ENTERSIZEMOVE），因此仍然需要下面这个更宽的 isSelfForeground 兜底：两个输入分别覆盖
// "正在拖拽"与"占着前台但没有拖拽"这两种都会产生同一个假信号的情形，只判断其中一个都会漏保护。
//
// getActiveWindowInfo() 同步返回，isSelfForeground 直接就是 kind === 'self'，不需要引入新的
// 时间窗口或魔法数字。硬证据（'gone'/'pid-mismatch'）在两种模式下都照常清除，见
// decideBlockerAfterValidation——一个真的已经退出的应用不会被这条收紧卡住。接受的代价：
// MintBot 占着前台期间，一个真的离开了全屏（而不是直接关闭）的应用不会立刻清掉 blocker，要
// 等到用户焦点移到别处之后的下一次校验才清——这是一个有界、会自我纠正的延迟，不是卡死。
//
// Fix 1（second rework pass）：isDragInProgress 这个参数要的是"任意一个 MintBot 窗口在拖"
// （electron/main/dragActivity.ts 的 isAnyDragInProgress），不是某一个特定窗口——不管抢焦点
// 的是悬浮窗还是聊天窗口的拖拽动作，都同样会让前台窗口瞬间读到 isFullscreen = false，这是
// 唯一需要收紧校验模式的原因，与"具体是哪个窗口在拖"无关
export function selectValidationMode(isSelfForeground: boolean, isDragInProgress: boolean): ValidationMode {
  return isSelfForeground || isDragInProgress ? 'conservative' : 'standard'
}

function runValidationPass(): void {
  // 拖拽期间收紧校验模式（electron/main/dragActivity.ts）：见 displayStateMap.ts 的
  // decideBlockerAfterValidation 对 conservative 模式的处理，以及 desktopPresence.ts
  // resolveDragOutcome 的 B1 分支为什么需要这一保护。selectValidationMode 头注释说明了为什么
  // "MintBot 自己是前台"也要收紧，不只是"正在拖拽"，以及为什么这里要用 isAnyDragInProgress
  // 而不是某一个窗口的 isWindowDragInProgress
  const mode = selectValidationMode(getActiveWindowInfo().kind === 'self', isAnyDragInProgress())
  displayStateMap = validateBlockers(displayStateMap, getWindowBehaviorRules(), probeBlockerWindow, mode)
}

// 供锁屏解除 / 显示器拓扑变化（新增显示器、拔掉显示器、分辨率变化）时立即触发一次校验，
// 不必等下一次轮询——见 docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"锁屏与解锁"及"显示器
// 拓扑变化"两节。
//
// "拓扑变化后不假设现有 displayId 仍然有效：重新获取 displays...重新验证 blocker 的归属"
// 不需要单独实现：validateBlockers 对每个已知 blocker 重新调用 probeBlockerWindow，后者内部用
// screen.getDisplayMatching(当前窗口矩形) 现查显示器——这个 Electron API 恒返回"当前接入的
// 显示器里离给定矩形最近的一个"，不可能返回一块已经拔掉的显示器，因此拓扑变化后重新走一遍
// 校验，天然完成"重新归属 + 丢弃不存在的显示器"这两件事，不需要额外的显示器差异比较逻辑
export function revalidateBlockersNow(): void {
  runValidationPass()
}

// 校验间隔选 1500ms，落在任务要求的 [1000, 2000] 区间中点：这条循环只重新核对"已经建立的
// 少量 blocker"（每块显示器至多一个），不做任何窗口枚举，单次开销远低于 500ms 一次、要
// 枚举/换算前台窗口全部信息的采样循环；建立/刷新这一半工作本来就走那条更快的路径（500ms
// 内可见），这条循环只负责"清除"这一件相对不紧急的事——悬浮窗此刻已经在别的屏幕上躲着，
// 清除慢一点用户感知不到实质差异，但也不能无下限地拖，1500ms 是两头都不占的折衷选择，
// 本阶段没有更强的论据把它定得更靠向区间的某一端
const BLOCKER_VALIDATION_INTERVAL_MS = 1500

// onValidated：每次这条循环真正跑完一轮校验（含首次那次立即执行）都调用一次，供
// index.ts 接一次 evaluateDesktopPresence（windowBehavior.ts）——TDD 原文要求 resolver 在
// "每一次 blocker 复查"之后都重新求一次 desired 状态，这样"blocker 消失但没有新的前台观测
// 触发"（例如挡路的窗口被直接关闭，而不是切到另一个窗口）也能被兜底捕捉到，不必等到下一次
// 前台变化。回调固定无参数——本文件不知道、也不需要知道决策层长什么样，只负责"我确实又
// 校验过一轮了"这一个通知，保持本文件不依赖 windowBehavior.ts 之外的任何决策概念。
//
// process.platform !== 'win32' 时直接空转（返回 no-op 清理函数），跟 startActiveWindowMonitor
// 同一个约定——probeBlockerWindow 在非 Windows 上本来就会因为绑定缺失恒定返回
// { status: 'gone' }，但没必要为了这个结果去启动一个定时器。这也意味着 onValidated 在非
// Windows 上完全不会被调用；index.ts 额外在 app.whenReady() 里无条件调用一次
// evaluateDesktopPresence 覆盖这个平台差异，见该调用点注释
export function startBlockerValidationLoop(onValidated: () => void): () => void {
  if (process.platform !== 'win32') {
    return () => {}
  }

  runValidationPass()
  onValidated()
  const handle = setInterval(() => {
    runValidationPass()
    onValidated()
  }, BLOCKER_VALIDATION_INTERVAL_MS)
  return () => clearInterval(handle)
}
