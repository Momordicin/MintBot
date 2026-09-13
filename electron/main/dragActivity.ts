import type { WindowKey } from './windowPositions'
import { PERSIST_DEBOUNCE_MS } from './windowPositions'

// 拖拽活跃度追踪（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」新增的拖拽期间合法性校验
// 需求）：拖拽这一刻，用户自己抢占前台焦点这件事，可能让 A 屏上原本全屏的程序瞬间读到
// isFullscreen = false（例如按下鼠标去拖悬浮窗，短暂抢走了那个全屏程序的前台焦点），这是
// 一个软信号，不能被当成"blocker 已经解除"的证据——见 displayStateMap.ts 的 conservative
// 校验模式。本模块只负责回答"现在是不是正处于一次用户拖拽中"，不做任何校验逻辑本身。
//
// Stage 3（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"更正（原记录有误）"一节）：改由
// WM_ENTERSIZEMOVE / WM_EXITSIZEMOVE 这对权威信号驱动（electron/main/windowDragMonitor.ts，
// 前身 overlayDragMonitor.ts——Stage 3 起两个窗口都挂钩，因此改名并推广），取代此前"最后一次
// 'moved' 起 1000ms 时间窗"的猜测。WM_ENTERSIZEMOVE 在鼠标按下、尚未产生任何 'moved' 事件时
// 就已经触发，正是保守清除规则要覆盖的抢焦点时刻——"按住不动的空窗期"因此不再需要靠采样
// 窗口去收窄，而是根本不存在。旧版本的 noteUserDragActivity/DRAG_CONSERVATIVE_WINDOW_MS 随
// 这次改动一起删除，不再由 windowBehavior.ts 的 handleWindowMoved（'moved' 事件）驱动。
//
// Fix 1（second rework pass，ts-backend-reviewer/integration-reviewer rework）：状态从"一个
// 全局标志"改为"按窗口分开"。原因是这个模块被三个不同的消费方读取，语义各不相同：
//   - resolvePetDesiredState 的 isInteracting（经 evaluatePetPresence）：TDD 把 ACTIVE 定义为
//     "用户正在直接与角色（悬浮窗）交互"——只应该看悬浮窗自己是否在被拖，看到聊天窗口在拖是
//     错的。旧的单一全局标志会让"用户在另一块屏拖动聊天窗口"把悬浮窗错误地判成 ACTIVE，
//     进而在悬浮窗此刻应该 HIDDEN（挡在一块全屏游戏后面）时，只靠 evaluatePetPresence 里的
//     chatFocused 这个巧合条件兜底，不是设计出来的正确性。
//   - evaluatePetPresence/evaluateChatPresence 各自"拖拽期间跳过自动 relocate"的守卫：同理，
//     必须只看自己这个窗口，不能被另一个窗口的拖拽状态误伤（例如聊天窗口正在拖，不该连带
//     压住悬浮窗本该发生的自动避让）。
//   - foregroundWorldModel.ts 的 selectValidationMode：这一个确实要"任意一个 MintBot 窗口在
//     拖"——它防的是我们自己抢焦点导致的 blocker 假性清除，不管抢焦点的是悬浮窗还是聊天窗口
//     的拖拽动作，都同样会让前台窗口瞬间读到 isFullscreen = false，因此保留一个跨窗口的
//     isAnyDragInProgress()。
//
// 两个窗口共用同一套函数签名（多一个 windowKey 参数），而不是两份几乎一样的模块状态——两个
// 窗口不会同时处于 Windows 的模态移动/缩放循环里（单个物理鼠标同一时刻只能拖一个原生窗口），
// 但"不会同时发生"不等于"语义相同"，仍然需要分开记，理由见上面三条。

interface WindowDragState {
  isDragging: boolean
  // isDragging 变为 true 的绝对时刻，只在 isDragging 为真时有意义——供 Fix 2 的有界自愈上限
  // 使用（见 MAX_DRAG_DURATION_MS）
  dragStartedAt: number
  // 拖拽结束后的静默尾巴到期时刻（绝对时间戳）。0 表示"从未进入过尾巴"，与"早已过期"是
  // 同一件事，isWindowDragInProgress 不需要为它单独判断
  tailUntil: number
}

function makeInitialDragState(): WindowDragState {
  return { isDragging: false, dragStartedAt: 0, tailUntil: 0 }
}

// 两个窗口各自独立的状态——一个固定形状的 Record（WindowKey 是封闭的两值联合），不是按需
// 增长的 Map，两个键从模块加载起就一直存在
const dragStates: Record<WindowKey, WindowDragState> = {
  overlay: makeInitialDragState(),
  chat: makeInitialDragState(),
}

// 尾巴时长 = 落盘防抖 + 一段事件投递延迟余量（150ms，与 windowBehavior.ts
// PROGRAMMATIC_ECHO_TAIL_MS 同一档、同一个理由：只需要盖住最后一帧事件本身的投递延迟，不是
// 再等一次防抖）。覆盖的是 TDD 原文那句"松手之后仍保留一小段尾巴，只为覆盖最后一个 moved 与
// 300ms 落盘防抖之间的间隙"：WM_EXITSIZEMOVE 触发之后，最后一次 'moved' 才会到达
// handleWindowMoved，紧接着排上 300ms 的落盘防抖，防抖到期时 persistBoundsNow 才真正执行、
// 落盘/回滚才真正生效——resolver 若在这整段窗口内把窗口挪走，会跟这次真实拖拽的收尾打架。
// PERSIST_DEBOUNCE_MS 本身定义在 windowPositions.ts（Fix 4：此前这里维护一份独立复制，跟
// windowBehavior.ts 的定义靠注释手动保持一致，是本项目一直在清理的那类漂移——windowPositions.ts
// 早已是两者共同的、无循环 import 风险的叶子模块，见该文件里这个常量定义处的注释）
export const DRAG_END_TAIL_MS = PERSIST_DEBOUNCE_MS + 150

// Fix 2（second rework pass，ts-backend-reviewer/integration-reviewer rework）：isDragging 曾经
// 只能被 noteDragEnd() 清除——但 WM_EXITSIZEMOVE 不是保证送达的：窗口可能在拖拽中途被销毁，
// OS 的模态移动循环可能被锁屏切换/RDP 断线打断，钩子本身也可能被卸载。一个卡死为 true 的
// 标志会往最坏的方向失效——悬浮窗被永久钉在 ACTIVE（自动避让/EDGE/HIDDEN 全部失效，可能永远
// 停在一块被全屏程序挡住的屏上），selectValidationMode 被永久钉在 conservative（软证据需要
// 连续确认才清除，永远等不到那几轮连续通过）。
//
// 这里加一个绝对上限：超过这个时长仍没有等到匹配的 noteDragEnd，就判定这次拖拽已经结束。
// 60 秒的取舍：一次真实的、连续的窗口拖拽持续超过一分钟是不现实的，而把它判错的代价很小——
// 只是恢复自动避让/恢复标准校验模式；不设上限的代价则是状态机可能永久卡死，两者不对称，
// 优先选择"偶尔提前结束一个理论上不存在的超长拖拽"。这条上限只在 isDragging 仍为 true 时
// 参与判断——它取代的是"永远等不到 noteDragEnd"这一种情况，不影响 tailUntil 那条已经有
// 明确到期时刻的常规路径
export const MAX_DRAG_DURATION_MS = 60_000

// 供 electron/main/windowDragMonitor.ts 在 WM_ENTERSIZEMOVE 时调用。now 可注入（供单测在不
// 依赖真实计时器的情况下验证 MAX_DRAG_DURATION_MS 上限）。进入一次新的拖拽即视为上一段尾巴
// 作废——正常时序下不会在 tailUntil 还没过期时又收到一次同一窗口的 WM_ENTERSIZEMOVE（两次
// 拖拽之间至少要先松手一次），这里仍然显式清零，保持"isDragging 为真时结果只取决于这一个
// 字段、不受尾巴残留影响"这个不变式，不必去想两个字段同时生效时该以谁为准
export function noteDragStart(windowKey: WindowKey, now: number = Date.now()): void {
  const state = dragStates[windowKey]
  state.isDragging = true
  state.dragStartedAt = now
  state.tailUntil = 0
}

// 供 electron/main/windowDragMonitor.ts 在 WM_EXITSIZEMOVE 时调用。now 可注入，供单测在不依赖
// 真实计时器的情况下验证尾巴边界
export function noteDragEnd(windowKey: WindowKey, now: number = Date.now()): void {
  const state = dragStates[windowKey]
  state.isDragging = false
  state.tailUntil = now + DRAG_END_TAIL_MS
}

// 单个窗口是否正处于一次拖拽（含尾巴）中。供 resolvePetDesiredState 的 isInteracting（只传
// 'overlay'）与 evaluatePetPresence/evaluateChatPresence 各自的"跳过自动 relocate"守卫
// （分别传各自的 windowKey）使用——三处都只关心"这一个窗口"，见本文件头部注释
//
// 非 win32：electron/main/windowDragMonitor.ts 的钩子函数本身是 no-op（见该文件），
// noteDragStart/noteDragEnd 永远不会被调用，两个窗口的状态恒为初始值——isWindowDragInProgress
// 因此在非 Windows 平台上自然恒为 false，不需要在这里再写一条平台分支，这条降级是"驱动信号
// 从不发生"的直接结果，而不是本函数自己判断 process.platform
export function isWindowDragInProgress(windowKey: WindowKey, now: number = Date.now()): boolean {
  const state = dragStates[windowKey]
  if (state.isDragging) {
    // Fix 2：有界自愈上限——迟迟等不到 WM_EXITSIZEMOVE 时，超过这个时长就不再相信 isDragging
    return now - state.dragStartedAt <= MAX_DRAG_DURATION_MS
  }
  return now < state.tailUntil
}

// 任意一个 MintBot 窗口是否正处于一次拖拽（含尾巴）中。唯一消费方是
// foregroundWorldModel.ts 的 selectValidationMode——它要防的是"我们自己抢焦点导致的假性
// blocker 清除"，不管抢焦点的是哪个窗口的拖拽动作，结论都一样，见本文件头部注释
export function isAnyDragInProgress(now: number = Date.now()): boolean {
  return isWindowDragInProgress('overlay', now) || isWindowDragInProgress('chat', now)
}

// Fix 2：另外两条有界恢复路径，覆盖"迟迟等不到 WM_EXITSIZEMOVE"里 MAX_DRAG_DURATION_MS 上限
// 之外、reviewer 点名的两种具体中断场景——锁屏/解锁（index.ts 已有对应的 powerMonitor
// handler，那里改为额外调用本函数）与窗口被销毁（index.ts 两个窗口的 'closed' 回调，同样
// 额外调用本函数）。直接重置回初始状态，而不是"当作 noteDragEnd 被调用过"（不会开一段
// DRAG_END_TAIL_MS 尾巴）——这不是一次真实拖拽的正常收尾，是主动丢弃一个可能已经卡住的状态，
// 没有"最后一帧事件还在路上"需要吸收
export function clearDragState(windowKey: WindowKey): void {
  dragStates[windowKey] = makeInitialDragState()
}

// 只收掉松手后的尾巴，不碰 isDragging。供 drag-end 的最终 placement 落定后调用——尾巴要覆盖
// 的那段（松手 → 落盘防抖跑完）此时已经结束。
//
// isDragging 为真时必须 no-op：落盘防抖从最后一次 moved 起算，用户可能在它到期前又抓住了
// 窗口，此时这次调用属于上一段拖拽，不能把新拖拽的 isDragging 清掉
export function endDragTail(windowKey: WindowKey): void {
  const state = dragStates[windowKey]
  if (state.isDragging) return
  state.tailUntil = 0
}
