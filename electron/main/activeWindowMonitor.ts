import koffi from 'koffi'
import path from 'path'
import { screen } from 'electron'

// Win32 活跃窗口监听（TDD §3.7「悬浮窗技术要点」+ Phase 3 checklist），本项目第一次用 FFI。
// 这一轮只做检测 + 日志，不做悬浮窗行为策略（跳屏/隐藏/白名单黑名单，那是下一个独立
// checklist 项）

const lib = process.platform === 'win32' ? koffi.load('user32.dll') : null
// OpenProcess/QueryFullProcessImageNameW/CloseHandle 是 kernel32.dll 导出的，不是 user32.dll——
// 跟窗口相关的 Get*/GetWindowThreadProcessId 那批不一样，需要单独 load 一次
const kernel32 = process.platform === 'win32' ? koffi.load('kernel32.dll') : null

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

// 前台窗口所属进程的 exe 文件名解析：拿窗口 → 拿进程 id → 打开进程句柄 → 查完整路径。
// 进程句柄类型复用同一个 HWND opaque 指针——Win32 里所有句柄底层都是不透明指针，
// 没必要为 OpenProcess 的返回值单独声明一个具名类型
const GetWindowThreadProcessId = lib
  ? lib.func('uint32_t __stdcall GetWindowThreadProcessId(HWND hWnd, _Out_ uint32_t *lpdwProcessId)')
  : null
const OpenProcess = kernel32
  ? kernel32.func('HWND __stdcall OpenProcess(uint32_t dwDesiredAccess, bool bInheritHandle, uint32_t dwProcessId)')
  : null
const QueryFullProcessImageNameW = kernel32
  ? kernel32.func(
      `bool __stdcall QueryFullProcessImageNameW(HWND hProcess, uint32_t dwFlags, _Out_ ${GET_WINDOW_TEXT_OUT_TYPE} lpExeName, _Inout_ uint32_t *lpdwSize)`
    )
  : null
const CloseHandle = kernel32 ? kernel32.func('bool __stdcall CloseHandle(HWND hObject)') : null
const GetWindowLongW = lib ? lib.func('int32_t __stdcall GetWindowLongW(HWND hWnd, int32_t nIndex)') : null

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

// GWL_STYLE 是负数索引（Win32 惯例），koffi 的 int32_t 参数类型可以正常传负值
const GWL_STYLE = -16
const WS_CAPTION = 0xc00000
const WS_THICKFRAME = 0x40000

export type ActiveWindowInfo = { title: string; isFullscreen: boolean; exeName: string | null }

// 拿前台窗口 handle 反查它所属进程的 exe 文件名（不含路径，如 "chrome.exe"）。任何一步
// 失败（拿不到 pid、OpenProcess 权限不足、查询失败）都返回 null，不影响调用方已经拿到
// 的 title/isFullscreen——句柄一旦 OpenProcess 成功就必须关闭，否则每 500ms 轮询一次
// 泄漏一个句柄，所以用 finally 保证无论成功失败都 CloseHandle
function resolveExeName(hwnd: unknown): string | null {
  if (!GetWindowThreadProcessId || !OpenProcess || !QueryFullProcessImageNameW || !CloseHandle) {
    return null
  }

  let processHandle: unknown = null
  try {
    const pidBuf = [0]
    GetWindowThreadProcessId(hwnd, pidBuf)
    const pid = pidBuf[0]
    if (!pid) return null

    processHandle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
    if (!processHandle) return null

    const exeNameBuf = ['\0'.repeat(255)]
    // _Inout_：传入时是缓冲区容量，QueryFullProcessImageNameW 成功后就地写回实际长度
    const sizeBuf = [256]
    const ok = QueryFullProcessImageNameW(processHandle, 0, exeNameBuf, sizeBuf)
    if (!ok) return null

    return path.basename(exeNameBuf[0])
  } catch {
    return null
  } finally {
    if (processHandle) CloseHandle(processHandle)
  }
}

// 单次查询：取前台窗口 handle → 取标题 → 取窗口矩形 → 用 Electron 自带的
// screen.getDisplayMatching 找到窗口所在显示器，比较矩形是否等于该显示器完整边界判断全屏，
// 再反查前台窗口所属进程的 exe 文件名。任何一步失败（FFI 调用异常、非 Windows 平台）都
// 返回 null，不抛错——跟 services/core/providers/ollama.ts 的 isOllamaRunning 一样的
// 降级风格；但 exe 文件名解析（resolveExeName）本身失败只让 exeName 落 null，不拖累
// title/isFullscreen 一起失败
export function getActiveWindowInfo(): ActiveWindowInfo | null {
  if (
    process.platform !== 'win32' ||
    !GetForegroundWindow ||
    !GetWindowTextW ||
    !GetWindowRect ||
    !RECT ||
    !GetWindowLongW
  ) {
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

    // GetWindowRect 返回物理像素，而 screen.getDisplayMatching 的匹配依据、Display.bounds
    // 都是 DIP——非 100% 缩放的显示器上两者单位不一致，此前 v1 直接用物理坐标做这两件事：
    // 传给 getDisplayMatching 会匹配到错误的显示器（实机诊断过物理 x=1125 的窗口被匹配到
    // 另一块屏幕的 DIP bounds 上），拿物理坐标精确比较 DIP bounds 则 rectMatchesDisplay
    // 恒为 false（假阴性）。用 screen.screenToDipRect(null, physicalRect) 把物理矩形换算成
    // DIP 后再参与这两步，两处都要用换算后的值，缺一处都还是错的
    const physicalRect = {
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    }
    const dipRect = screen.screenToDipRect(null, physicalRect)

    const display = screen.getDisplayMatching(dipRect)
    // v2：不加容差。依据是 screenToDipRect 与 display.bounds 走的是 Chromium 内部同一套
    // 物理→DIP 转换（按方向取整、保证换算结果完整覆盖原物理矩形），因此窗口矩形真正等于
    // 显示器物理边界时两边结果逐像素相等。实机数据印证了这一点：1920×1080 物理 @1.4 缩放
    // 换算出 1372×772，与 display.bounds 精确吻合（注意 1920/1.4=1371.43，能对上 1372 是
    // 因为右下角取 ceil 而非四舍五入）。
    // ⚠️ 但"两条路径共用同一套换算"是 Chromium 的内部实现细节，公开 API 并未承诺——目前
    // 靠实机现象反推成立。若日后 Electron 升级导致两条换算路径出现分歧，这里会无提示地
    // 退回"恒为 false"的假阴性（正是 v1 的症状）。加容差会掩盖这个信号，所以仍选精确相等，
    // 但排查 isFullscreen 失效时应优先怀疑这一点
    const rectMatchesDisplay =
      dipRect.x === display.bounds.x &&
      dipRect.y === display.bounds.y &&
      dipRect.x + dipRect.width === display.bounds.x + display.bounds.width &&
      dipRect.y + dipRect.height === display.bounds.y + display.bounds.height

    // 仅矩形等于显示器边界不足以区分"真全屏"和"普通窗口被最大化到铺满屏幕"——两者视觉
    // 上都占满显示器，但真全屏（独占全屏游戏/播放器）通常创建窗口时就不带标题栏/可调边框
    // 样式位，普通窗口即使最大化也仍然带着这两个样式位。这个启发式还没有拿真机上的全屏
    // 游戏/视频播放器验证过，之后如果发现误判需要回来调整
    const style = GetWindowLongW(hwnd, GWL_STYLE)
    const hasCaptionOrThickFrame = (style & (WS_CAPTION | WS_THICKFRAME)) !== 0
    const isFullscreen = rectMatchesDisplay && !hasCaptionOrThickFrame

    const exeName = resolveExeName(hwnd)
    // MintBot 自己的三个窗口（聊天/悬浮/设置）共用同一个宿主进程 exe，用这一个条件就能
    // 排除全部三个窗口，不需要分别识别各自的标题。大小写不敏感比较——Windows 文件系统
    // 本身大小写不敏感，QueryFullProcessImageNameW 返回的大小写不保证跟 process.execPath
    // 一致，这里如果按区分大小写比较，一旦两边大小写不同就会静默失效（fail open：把自己
    // 的窗口当成外部程序处理），比检测不到全屏还危险
    if (exeName !== null && exeName.toLowerCase() === path.basename(process.execPath).toLowerCase()) {
      return null
    }

    return { title, isFullscreen, exeName }
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
        : previous === null ||
          current.title !== previous.title ||
          current.isFullscreen !== previous.isFullscreen ||
          current.exeName !== previous.exeName

    if (changed) {
      previous = current
      onChange(current)
    }
  }, 500)

  return () => clearInterval(handle)
}
