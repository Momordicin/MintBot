import koffi from 'koffi'
import { screen } from 'electron'

// Win32 活跃窗口监听（TDD §3.7「悬浮窗技术要点」+ Phase 3 checklist），本项目第一次用 FFI。
// 这一轮只做检测 + 日志，不做悬浮窗行为策略（跳屏/隐藏/白名单黑名单，那是下一个独立
// checklist 项），也不做"检测到的窗口是不是 MintBot 自己"的判断（留给行为策略任务）

const lib = process.platform === 'win32' ? koffi.load('user32.dll') : null

const HWND = lib ? koffi.pointer('HWND', koffi.opaque()) : null
const RECT = lib
  ? koffi.struct('RECT', {
      left: 'int32_t',
      top: 'int32_t',
      right: 'int32_t',
      bottom: 'int32_t',
    })
  : null

// 真机验证过 char16_t * 能正确取到中文标题（koffi 文档里 char16_t */str16 本就是同一
// 类型的两种写法，不是需要二选一的候选项，这里只是保留一个具名常量方便以后统一改写法）
const GET_WINDOW_TEXT_OUT_TYPE = 'char16_t *'

const GetForegroundWindow = lib ? lib.func('HWND __stdcall GetForegroundWindow()') : null
const GetWindowTextW = lib
  ? lib.func(`int __stdcall GetWindowTextW(HWND hWnd, _Out_ ${GET_WINDOW_TEXT_OUT_TYPE} lpString, int nMaxCount)`)
  : null
const GetWindowRect = lib ? lib.func('bool __stdcall GetWindowRect(HWND hWnd, _Out_ RECT *lpRect)') : null

export type ActiveWindowInfo = { title: string; isFullscreen: boolean }

// 单次查询：取前台窗口 handle → 取标题 → 取窗口矩形 → 用 Electron 自带的
// screen.getDisplayMatching 找到窗口所在显示器，比较矩形是否等于该显示器完整边界判断全屏。
// 任何一步失败（FFI 调用异常、非 Windows 平台）都返回 null，不抛错——跟
// services/core/providers/ollama.ts 的 isOllamaRunning 一样的降级风格
export function getActiveWindowInfo(): ActiveWindowInfo | null {
  if (process.platform !== 'win32' || !GetForegroundWindow || !GetWindowTextW || !GetWindowRect || !RECT) {
    return null
  }

  try {
    const hwnd = GetForegroundWindow()
    if (!hwnd) return null

    // JS 字符串不可变，koffi 要求输出字符串参数用单元素数组包装
    const titleBuf = ['\0'.repeat(255)]
    GetWindowTextW(hwnd, titleBuf, 256)
    const title = titleBuf[0]

    // 传入空对象作为输出参数，koffi 就地填充字段
    const rect = {} as { left: number; top: number; right: number; bottom: number }
    const gotRect = GetWindowRect(hwnd, rect)
    if (!gotRect) return null

    const display = screen.getDisplayMatching({
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    })
    // v1 启发式：精确相等即视为全屏，不做容差。已知风险：GetWindowRect 返回物理像素，
    // screen.getDisplayMatching(...).bounds 在非 100% DPI 缩放的显示器上可能是逻辑像素，
    // 两者单位不一致时这里会一直判定为非全屏（假阴性）——下一个"悬浮窗行为策略"任务
    // 消费 isFullscreen 之前需要先确认/修这个问题，不能默认这个值在缩放屏幕上也准
    const isFullscreen =
      rect.left === display.bounds.x &&
      rect.top === display.bounds.y &&
      rect.right === display.bounds.x + display.bounds.width &&
      rect.bottom === display.bounds.y + display.bounds.height

    return { title, isFullscreen }
  } catch {
    return null
  }
}

// process.platform !== 'win32' 时直接空转（返回 no-op 清理函数），不尝试任何 macOS 等价
// 实现——按用户明确说的"现在不把重心放在双端"
export function startActiveWindowMonitor(onChange: (info: ActiveWindowInfo | null) => void): () => void {
  if (process.platform !== 'win32') {
    return () => {}
  }

  let previous: ActiveWindowInfo | null = null

  // 500ms 轮询间隔是 TDD §3.7 明确写的；只有结果相比上一次真正变化时才回调，
  // 避免每 500ms 都触发一次相同数据的 onChange（两边都是 null 也算"未变化"）
  const handle = setInterval(() => {
    const current = getActiveWindowInfo()
    const changed =
      current === null
        ? previous !== null
        : previous === null || current.title !== previous.title || current.isFullscreen !== previous.isFullscreen

    if (changed) {
      previous = current
      onChange(current)
    }
  }, 500)

  return () => clearInterval(handle)
}
