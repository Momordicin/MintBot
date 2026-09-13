import koffi from 'koffi'
import path from 'path'
import { screen } from 'electron'
import type { BlockerProbe } from './displayStateMap'

// Win32 活跃窗口监听（TDD §3.7「悬浮窗技术要点」+ Phase 3 checklist），本项目第一次用 FFI。
//
// Stage 1（fullscreen/window-avoidance 状态机重设计的第一步，即 docs/MintBot_TDD.md §3.7
// 附「桌面呈现状态机（Desktop Presence，四阶段重设计）」表格里的阶段①——不是开头泛指的
// §3.7 正文，那一节仍描述被取代的旧「检测到全屏 → 跳屏/单屏隐藏」模型）：本文件从"每次只
// 吐出当前前台窗口的一份快照，null 代表任何
// 没有新信息的情况"扩展成一个显式的三态 Observation（external/self/unavailable），并新增
// probeBlockerWindow 供低频校验循环（electron/main/foregroundWorldModel.ts）复用同一套
// Win32 绑定重新核对"已知的显示器阻塞源是否还成立"。
//
// Stage 2：曾经在这里的 ActiveWindowInfo | null 契约与 toActiveWindowInfo() 适配器已删除——
// 决策层（windowBehavior.ts 的 evaluatePetPresence/evaluateChatPresence）现在直接读
// foregroundWorldModel.ts 的 getDisplayStateMap()，不再需要一个"把三态观测塌缩回旧二值
// 契约"的兼容层，见 windowBehavior.ts 顶部注释

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
// Stage 1 新增：只给低频校验循环（foregroundWorldModel.ts 的 validateBlockers）用，核实一个
// "已知 blocker" 记的 hwnd 数值此刻是否还对应任何窗口——不参与每 500ms 一次的前台采样
const IsWindow = lib ? lib.func('bool __stdcall IsWindow(HWND hWnd)') : null

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

// GWL_STYLE 是负数索引（Win32 惯例），koffi 的 int32_t 参数类型可以正常传负值
const GWL_STYLE = -16
const WS_CAPTION = 0xc00000
const WS_THICKFRAME = 0x40000

// 全屏判据每边的容差（DIP）。v2（本文件此前版本）不加容差，依据是"screenToDipRect 与
// display.bounds 走同一套 Chromium 内部换算，两边结果逐像素相等"——这个假设遇到无边框全屏
// 窗口（borderless fullscreen）时不成立：这类窗口常常自己往里收 1-2px（有的引擎/播放器
// 刻意如此，避免边缘被裁切），导致窗口矩形与显示器边界永远差那么一两个像素，v2 的精确相等
// 判断会把它们错判成"不是全屏"。
// 选 2 而不是允许范围 [2,3] 里更宽松的 3：v2 注释已经实测记录过 screenToDipRect 单次换算
// 本身就可能带 1px 取整误差（1920/1.4=1371.43→1372 是原文实测案例），2px 恰好在"盖住这类
// 换算误差 + 1-2px 的无边框留白"之外仍然保持较紧——容差越宽，越可能把"故意留了几像素装饰
// 边框的正常窗口"也误判成全屏，2 是两者之间更保守的取值
const FULLSCREEN_TOLERANCE_DIP = 2

type PlainRect = { x: number; y: number; width: number; height: number }

// 纯函数：窗口矩形（DIP）是否与显示器边界重合（容差内）、且不带标题栏/可调边框样式位。
// 从 getActiveWindowInfo 内联判断中抽出来，供 probeBlockerWindow（Stage 1 校验循环）复用
// 同一份容差常量与公式——不允许两处各自维护一份数值，那样迟早会漂移出两套判据
export function isFullscreenRect(dipRect: PlainRect, displayBounds: PlainRect, style: number): boolean {
  const rectMatchesDisplay =
    Math.abs(dipRect.x - displayBounds.x) <= FULLSCREEN_TOLERANCE_DIP &&
    Math.abs(dipRect.y - displayBounds.y) <= FULLSCREEN_TOLERANCE_DIP &&
    Math.abs(dipRect.x + dipRect.width - (displayBounds.x + displayBounds.width)) <= FULLSCREEN_TOLERANCE_DIP &&
    Math.abs(dipRect.y + dipRect.height - (displayBounds.y + displayBounds.height)) <= FULLSCREEN_TOLERANCE_DIP

  // 仅矩形等于显示器边界不足以区分"真全屏"和"普通窗口被最大化到铺满屏幕"——两者视觉
  // 上都占满显示器，但真全屏（独占全屏游戏/播放器）通常创建窗口时就不带标题栏/可调边框
  // 样式位，普通窗口即使最大化也仍然带着这两个样式位。这个启发式还没有拿真机上的全屏
  // 游戏/视频播放器验证过，之后如果发现误判需要回来调整
  const hasCaptionOrThickFrame = (style & (WS_CAPTION | WS_THICKFRAME)) !== 0
  return rectMatchesDisplay && !hasCaptionOrThickFrame
}

// 前台观察的第三方窗口信息。相比 Stage 1 之前的 ActiveWindowInfo，新增 hwnd（窗口身份——
// 同一个 exe，如 chrome.exe，可以同时拥有多个窗口，仅凭 exe 名分不清"焦点在哪一个窗口上
// 切换"）与 pid（供 Stage 1 校验循环做 HWND 回收的交叉核对，见 probeBlockerWindow）
export type ExternalWindowInfo = {
  hwnd: bigint
  // Finding B（Stage 1 review）：pid 解析可能瞬时失败（GetWindowThreadProcessId 出错），
  // null 而不是把整次观察判定成 unavailable——pid 只在 Stage 1 校验循环里做 HWND 回收的
  // 交叉核对时才是刚需（见 probeBlockerWindow），前台观察本身（title/isFullscreen/exeName/
  // displayId）不依赖它就能成立，legacy ActiveWindowInfo 也从不读这个字段。类型允许 null，
  // 而不是靠"调用方自己记得 pid 可能不可靠"这种约定：displayStateMap.ts 的
  // applyExternalObservation 在 pid 为 null 时选择"不建立 blocker"而不是拿一个不可靠的值
  // 去建立一个本该支持"HWND 回收核对"的记录
  pid: number | null
  title: string
  isFullscreen: boolean
  exeName: string | null
  displayId: number
}

// 三态前台观察，取代此前"ActiveWindowInfo | null"这个二值契约：
// - external：确有一个第三方前台窗口，携带完整信息
// - self：前台就是 MintBot 自己——不带任何关于外部世界的新信息，但也绝不能被当成
//   "桌面已确认干净"处理（否则悬浮窗会在用户切回聊天窗口的瞬间以为冲突已解除）
// - unavailable：这次采样没有可用信息（Win32 调用失败、或非 Windows 平台）——同样不能被
//   当成"桌面已确认干净"
// 这个区分是本次重设计要分离的两个概念之一："前台"（谁在被操作）与"显示器阻塞源"
// （哪块屏此刻不宜使用）——见 docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"为什么要重设计"
// 一节对 Foreground Window / Display Blocker 的定义
export type ForegroundObservation =
  | { kind: 'external'; info: ExternalWindowInfo }
  | { kind: 'self' }
  | { kind: 'unavailable' }


// 拿窗口 handle 反查它所属进程的 pid。从 resolveExeName 里独立出来（此前 pid 只是
// resolveExeName 内部的一个中间值，不对外暴露）——Stage 1 需要把 pid 放进
// ExternalWindowInfo，调用方只应该查一次，不应该为了"既要 exe 名又要 pid"而对同一个 hwnd
// 调用两次 GetWindowThreadProcessId
function resolvePid(hwnd: unknown): number | null {
  if (!GetWindowThreadProcessId) return null
  const pidBuf = [0]
  GetWindowThreadProcessId(hwnd, pidBuf)
  const pid = pidBuf[0]
  return pid || null
}

// 用已经解析好的 pid 反查其 exe 文件名（不含路径，如 "chrome.exe"）。任何一步失败
// （OpenProcess 权限不足、查询失败）都返回 null，不影响调用方已经拿到的其它字段——句柄
// 一旦 OpenProcess 成功就必须关闭，否则每次轮询泄漏一个句柄，所以用 finally 保证无论成功
// 失败都 CloseHandle
function resolveExeName(pid: number): string | null {
  if (!OpenProcess || !QueryFullProcessImageNameW || !CloseHandle) {
    return null
  }

  let processHandle: unknown = null
  try {
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
// screen.getDisplayMatching 找到窗口所在显示器，比较矩形是否落在该显示器完整边界的容差内
// 判断全屏，再反查前台窗口所属进程的 pid/exe 文件名。任何一步失败（FFI 调用异常、非
// Windows 平台）都返回 { kind: 'unavailable' }，不抛错——跟
// services/core/providers/ollama.ts 的 isOllamaRunning 一样的降级风格
export function getActiveWindowInfo(): ForegroundObservation {
  if (
    process.platform !== 'win32' ||
    !GetForegroundWindow ||
    !GetWindowTextW ||
    !GetWindowRect ||
    !RECT ||
    !GetWindowLongW ||
    !GetWindowThreadProcessId
  ) {
    return { kind: 'unavailable' }
  }

  try {
    const hwnd = GetForegroundWindow()
    if (!hwnd) return { kind: 'unavailable' }

    // JS 字符串不可变，koffi 要求输出字符串参数用单元素数组包装
    const titleBuf = ['\0'.repeat(255)]
    GetWindowTextW(hwnd, titleBuf, 256)
    const title = titleBuf[0]

    // 传入空对象作为输出参数，koffi 就地填充字段
    const rect = {} as { left: number; top: number; right: number; bottom: number }
    const gotRect = GetWindowRect(hwnd, rect)
    if (!gotRect) return { kind: 'unavailable' }

    // GetWindowRect 返回物理像素，而 screen.getDisplayMatching 的匹配依据、Display.bounds
    // 都是 DIP——非 100% 缩放的显示器上两者单位不一致，此前 v1 直接用物理坐标做这两件事：
    // 传给 getDisplayMatching 会匹配到错误的显示器，拿物理坐标精确比较 DIP bounds 则
    // rectMatchesDisplay 恒为 false（假阴性）。用 screen.screenToDipRect(null, physicalRect)
    // 把物理矩形换算成 DIP 后再参与这两步，两处都要用换算后的值，缺一处都还是错的
    const physicalRect = {
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    }
    const dipRect = screen.screenToDipRect(null, physicalRect)
    const display = screen.getDisplayMatching(dipRect)

    const style = GetWindowLongW(hwnd, GWL_STYLE)
    const isFullscreen = isFullscreenRect(dipRect, display.bounds, style)

    // Finding B（Stage 1 review）：pid 解析失败不再让整次观察塌缩成 unavailable。此前
    // Stage 1 把 pid 提到这一层之后在这里直接 `if (pid === null) return { kind: 'unavailable' }`，
    // 导致 handleOverlayDodge/handlePinMode 与 updateDisplayStateMap 整个跳过这一 tick——而
    // Stage 1 之前 pid 只是 resolveExeName 内部一个中间值，解析失败时只影响 exeName（变成
    // null），fullscreen 驱动的躲避逻辑照常生效。这里恢复那份旧的降级行为：exeName 解析
    // 失败（连带 pid 本身解析失败）时只是让 exeName/pid 为 null，不影响其余字段
    const pid = resolvePid(hwnd)
    const exeName = pid !== null ? resolveExeName(pid) : null

    // MintBot 自己的三个窗口（聊天/悬浮/设置）共用同一个宿主进程 exe，用这一个条件就能
    // 排除全部三个窗口，不需要分别识别各自的标题。大小写不敏感比较——Windows 文件系统
    // 本身大小写不敏感，QueryFullProcessImageNameW 返回的大小写不保证跟 process.execPath
    // 一致，这里如果按区分大小写比较，一旦两边大小写不同就会静默失效（fail open：把自己
    // 的窗口当成外部程序处理），比检测不到全屏还危险
    if (exeName !== null && exeName.toLowerCase() === path.basename(process.execPath).toLowerCase()) {
      return { kind: 'self' }
    }

    return {
      kind: 'external',
      info: { hwnd: koffi.address(hwnd), pid, title, isFullscreen, exeName, displayId: display.id },
    }
  } catch {
    return { kind: 'unavailable' }
  }
}

// 判定两次观察是否"实质变化"，决定轮询是否触发 onChange。指纹从此前的
// title/isFullscreen/exeName/displayId 改为 hwnd/isFullscreen/exeName/displayId：title
// 几乎总在抖动（浏览器标签页标题、播放器曲目名、IDE 当前文件名随时变化），几乎从不代表
// 策略层关心的变化，用它当门槛只会让下游（Stage 1 的 DisplayStateMap 建立/刷新）被无意义
// 地高频重复触发。title 仍然保留在 ExternalWindowInfo 里作为元数据（未来的规则可能用到
// 它），只是不再单独触发下游工作。hwnd 换成显式参与指纹，是因为同一个 exe（如 chrome.exe）
// 可以同时拥有多个窗口，仅凭 exe 名无法区分"前台从窗口 A 切到窗口 B"——这类切换在 Stage 2
// 之后可能是策略相关的变化
export function observationFingerprint(observation: ForegroundObservation): string {
  if (observation.kind !== 'external') return observation.kind
  const { hwnd, isFullscreen, exeName, displayId } = observation.info
  return `external:${hwnd}:${isFullscreen}:${exeName}:${displayId}`
}

// process.platform !== 'win32' 时直接空转（返回 no-op 清理函数），不尝试任何 macOS 等价
// 实现——按用户明确说的"现在不把重心放在双端"
export function startActiveWindowMonitor(onChange: (observation: ForegroundObservation) => void): () => void {
  if (process.platform !== 'win32') {
    return () => {}
  }

  let previousFingerprint: string | null = null

  // 500ms 轮询间隔是 TDD §3.7 明确写的；只有指纹相比上一次真正变化时才回调，避免每 500ms
  // 都触发一次相同数据的 onChange
  const handle = setInterval(() => {
    const current = getActiveWindowInfo()
    const currentFingerprint = observationFingerprint(current)

    if (currentFingerprint !== previousFingerprint) {
      previousFingerprint = currentFingerprint
      onChange(current)
    }
  }, 500)

  return () => clearInterval(handle)
}

// Stage 1 低频校验循环（electron/main/foregroundWorldModel.ts 的 validateBlockers）用来
// 重新核实"这个已知 blocker 的 hwnd 是否还成立"的 Win32 探针。只探测调用方给定的单个
// hwnd，不枚举任何窗口——已知 blocker 集合数量以显示器数为上限，天然很小，这是 TDD
// 描述里"不枚举全部顶层窗口"的落地点。
//
// ⚠️ pid 交叉核对是强制的：IsWindow(hwnd) 为真只能证明"这个数值地址此刻对应某个窗口"，
// Windows 会把已销毁窗口的 HWND 数值回收、重新分配给毫不相关的新窗口——只看 IsWindow 会把
// 这个无关的新窗口误认成还在的旧 blocker（ghost blocker：永远清不掉，悬浮窗被永久困在
// 让位状态）。因此这里在 IsWindow 通过之后，必须再用 GetWindowThreadProcessId 查一次这个
// hwnd 当前所属的 pid，跟调用方记的 pid 比对，不一致就判定为"HWND 已被回收"
// Finding A（Stage 1 review）：日志去重记录——同一个 hwnd 连续探测失败（异常，或
// resolvePid 返回 null）时，只在它从"上次探测有确定结果"变成"这次失败"的那一刻打一条
// console.error，此后同一个 hwnd 只要还在持续失败就不再重复打（不然 1500ms 一次的校验循环
// 会对着一个持续失败的探针刷屏）。任何一次探测得到确定性结果（'ok'/'gone'/'pid-mismatch'）
// 都清掉这个 hwnd 的记录，这样它将来（哪怕是被回收给了别的进程）再次失败时仍然会重新提醒
const hwndsWithLoggedProbeError = new Set<bigint>()

function logProbeErrorOnce(hwnd: bigint, reason: string): void {
  if (hwndsWithLoggedProbeError.has(hwnd)) return
  hwndsWithLoggedProbeError.add(hwnd)
  console.error(
    `[activeWindowMonitor] probeBlockerWindow: could not determine state for hwnd=${hwnd} (${reason}); keeping the existing blocker rather than treating this as evidence it is gone`
  )
}

// 纯函数：pid 交叉核对的三态判定，从 probeBlockerWindow 里单独抽出来——跟 isFullscreenRect
// 抽出来的理由一样，probeBlockerWindow 本身依赖真实 Win32 调用不适合直接单测，但这一步判定
// 不需要任何 Win32 状态。Finding A（Stage 1 review）要分清的两种情况在这里显式区分：
// resolvePid 失败返回 null（`null !== pid` 会恒真，若直接拿去跟 pid 比较就会被误判成
// pid-mismatch）是 'probe-error'——没查到任何 pid，不是"查到了一个不匹配的 pid"；只有真的
// 查到一个具体、不等于期望值的 pid 时才是 'pid-mismatch'（HWND 被回收给了别的进程）
export function classifyPidCheck(currentPid: number | null, expectedPid: number): 'match' | 'pid-mismatch' | 'probe-error' {
  if (currentPid === null) return 'probe-error'
  if (currentPid !== expectedPid) return 'pid-mismatch'
  return 'match'
}

// Fix 6（ts-backend-reviewer rework）：一次 GetWindowRect 读取失败此前被当成 { status: 'gone' }
// 处理，但走到这一步时 IsWindow 与 pid 交叉核对都已经通过——窗口确实还在、也确实是原来那个
// 进程，只是这一次矩形读取本身失败了。这是"无法判定"，不是"确认不存在"，跟
// docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"任何 Win32 读取失败…都只能判为『无法判定 →
// 保留』"是同一条规则，此前这里是唯一还没有遵守它的分支。抽成纯函数单独测——跟
// classifyPidCheck 同一个理由，probeBlockerWindow 本身依赖真实 Win32 调用不适合直接单测
// （见文件头注释）
export function classifyRectProbe(gotRect: boolean): 'ok' | 'probe-error' {
  return gotRect ? 'ok' : 'probe-error'
}

export function probeBlockerWindow(hwnd: bigint, pid: number): BlockerProbe {
  // Fix E（second rework pass, document-don't-change）：this is the one remaining place where
  // "cannot determine" deliberately collapses to 'gone' rather than 'probe-error'. It is only
  // reachable when the Win32 bindings themselves failed to load — non-Windows platforms, or a
  // koffi.load()/lib.func() failure at module init — in which case the entire feature (blocker
  // establishment, validation, resolver-driven presence) is already inert: startBlockerValidationLoop
  // and startActiveWindowMonitor both no-op on process.platform !== 'win32', and on a real Windows
  // failure there would be no bindings anywhere in this module to build a DisplayStateMap with in
  // the first place. There is no live blocker this branch could wrongly clear, so collapsing to
  // 'gone' here is safe, unlike every other "无法判定" case in this file (classifyPidCheck /
  // classifyRectProbe / the catch block below), which must and do return 'probe-error'.
  if (!IsWindow || !GetWindowThreadProcessId || !GetWindowRect || !RECT || !GetWindowLongW) {
    return { status: 'gone' }
  }

  try {
    if (!IsWindow(hwnd)) {
      hwndsWithLoggedProbeError.delete(hwnd)
      return { status: 'gone' }
    }

    const currentPid = resolvePid(hwnd)
    const pidCheck = classifyPidCheck(currentPid, pid)
    if (pidCheck === 'probe-error') {
      logProbeErrorOnce(hwnd, 'GetWindowThreadProcessId failed to resolve a pid')
      return { status: 'probe-error' }
    }
    if (pidCheck === 'pid-mismatch') {
      hwndsWithLoggedProbeError.delete(hwnd)
      return { status: 'pid-mismatch' }
    }

    const rect = {} as { left: number; top: number; right: number; bottom: number }
    const gotRect = GetWindowRect(hwnd, rect)
    if (classifyRectProbe(gotRect) === 'probe-error') {
      // 见 classifyRectProbe 定义处注释：IsWindow 与 pid 交叉核对都已经通过，这里的失败只能
      // 判定为"无法判定"，不能当成 'gone'
      logProbeErrorOnce(hwnd, 'GetWindowRect failed after IsWindow/pid checks already passed')
      return { status: 'probe-error' }
    }

    const physicalRect = {
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    }
    const dipRect = screen.screenToDipRect(null, physicalRect)
    const display = screen.getDisplayMatching(dipRect)
    const style = GetWindowLongW(hwnd, GWL_STYLE)
    const isFullscreen = isFullscreenRect(dipRect, display.bounds, style)

    hwndsWithLoggedProbeError.delete(hwnd)
    return { status: 'ok', displayId: display.id, isFullscreen }
  } catch (err) {
    // Finding A（Stage 1 review）：任何异常（koffi 回归、权限错误等）此前一律等同于"窗口
    // 已经不存在"（'gone'），这会清掉一个可能仍然合法的 blocker。异常只代表"这次没能观察
    // 到"，不是"确认不存在"的证据——两者混为一谈，正是这条边界本该可诊断却被静默 catch 吃掉
    // 的地方，因此这里同样落到 'probe-error' 并打一条（去重后的）日志
    logProbeErrorOnce(hwnd, err instanceof Error ? err.message : String(err))
    return { status: 'probe-error' }
  }
}
