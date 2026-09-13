import type { BrowserWindow } from 'electron'

// 窗口拖拽起止检测（TDD §3.7 附「拖拽的实现方式：原生拖动区，不自绘」）：挂 Windows 消息
// WM_ENTERSIZEMOVE（开始拖）/ WM_EXITSIZEMOVE（松手），不使用「一段时间没再移动即视为松手」
// 这类 debounce 猜测——TDD 明确指出那会把拖拽途中的停顿误判成松手，导致转场在用户仍按着
// 鼠标时就开始播放并上锁。回调保持零逻辑，只做信号转发（TDD §3.2「主进程只转发原始系统
// 信号，不携带业务逻辑」）。
//
// Stage 3（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"更正（原记录有误）"一节）：本文件
// 前身是 overlayDragMonitor.ts，只挂悬浮窗、只把信号转发给悬浮窗渲染层。现在
// electron/main/dragActivity.ts 的 isWindowDragInProgress() 直接由这对信号驱动（取代此前
// "最后一次 moved 起 1000ms 时间窗"的猜测），而聊天窗口一样会走 persistBoundsNow/
// resolveDragOutcome 这条拖拽合法性校验路径（见 windowBehavior.ts）——因此两个窗口都要挂钩，
// 不再只挂悬浮窗一个。文件改名是这次收窄范围的直接反映：调用方（electron/main/index.ts）
// 对悬浮窗调用时仍然转发 IPC 给悬浮窗渲染层（拖拽语义判断留给渲染层，见该调用点），额外调用
// electron/main/dragActivity.ts 的 noteDragStart/noteDragEnd；对聊天窗口调用时只驱动
// dragActivity.ts，聊天窗口渲染层不消费这对信号，也不需要——聊天窗口没有自绘立绘/转场
// 状态机，只有主进程自己的拖拽合法性判断需要知道它在拖。
//
// 跟 activeWindowMonitor.ts 同样的降级风格：非 win32 直接返回 no-op，不尝试任何等价实现
//
// ⚠️ 已知风险：钩子与窗口实例解耦，不保存本函数返回的 unhook 函数。第二次 rework pass 之前
// 这里断言"两个窗口都只有一个调用点"，那个断言并不成立——electron/main/index.ts 的
// `app.on('activate', ...)` 是 createWindow() 的第二个调用点（`getAllWindows().length === 0`
// 时重建聊天窗口）。已改为在该调用点同样挂钩（见 index.ts 该处的 Fix 5 注释），不再有一个
// "重建出的窗口收不到起止信号"的静默失效路径。createOverlayWindow() 目前确实仍只有一个
// 调用点（悬浮窗没有对应的重建路径）。这条不变式（"每个会被挂钩的窗口实例都恰好挂一次、
// 不需要保存 unhook"）现在依赖的前提改成了"两个窗口各自的每一个构造调用点都记得挂钩"，而不是
// "只有一个调用点"——日后新增第三个调用点（任一窗口）时，必须回来同样处理，否则会重新引入
// 这里描述的静默失效
const WM_ENTERSIZEMOVE = 0x0231
const WM_EXITSIZEMOVE = 0x0232

export function startWindowDragMonitor(
  win: BrowserWindow,
  onDragStart: () => void,
  onDragEnd: () => void
): () => void {
  if (process.platform !== 'win32') {
    return () => {}
  }

  win.hookWindowMessage(WM_ENTERSIZEMOVE, () => onDragStart())
  win.hookWindowMessage(WM_EXITSIZEMOVE, () => onDragEnd())

  return () => {
    if (win.isDestroyed()) return
    win.unhookWindowMessage(WM_ENTERSIZEMOVE)
    win.unhookWindowMessage(WM_EXITSIZEMOVE)
  }
}
