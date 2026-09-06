import type { BrowserWindow } from 'electron'

// 悬浮窗拖拽起止检测（TDD §3.7 附「拖拽的实现方式：原生拖动区，不自绘」）：挂 Windows 消息
// WM_ENTERSIZEMOVE（开始拖）/ WM_EXITSIZEMOVE（松手），不使用「一段时间没再移动即视为松手」
// 这类 debounce 猜测——TDD 明确指出那会把拖拽途中的停顿误判成松手，导致转场在用户仍按着
// 鼠标时就开始播放并上锁。回调保持零逻辑，只做信号转发（TDD §3.2「主进程只转发原始系统
// 信号，不携带业务逻辑」），拖拽语义判断（何时上锁、no-drag 切换）全部留给悬浮窗渲染层。
//
// 跟 activeWindowMonitor.ts 同样的降级风格：非 win32 直接返回 no-op，不尝试任何等价实现
//
// ⚠️ 已知风险：钩子与窗口实例解耦。调用方（electron/main/index.ts）没有保存本函数返回的
// unhook 函数，依据是悬浮窗在当前实现里每个进程生命周期只创建一次——createOverlayWindow()
// 只有一个调用点，且非 darwin 上 window-all-closed 直接 app.quit()，不存在销毁后重建的路径。
// 该前提一旦被打破（例如日后改成关闭即销毁、需要时再建），新窗口不会被挂钩，拖拽检测会
// **静默失效**——不报错、只是永远收不到起止信号。这与 windowBehavior.ts 里 lastAppliedOnTop
// 缓存是同一类假设（那处已有同款 ⚠️ 标注）：改动窗口销毁/重建策略时两处都必须回来处理
const WM_ENTERSIZEMOVE = 0x0231
const WM_EXITSIZEMOVE = 0x0232

export function startOverlayDragMonitor(
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
