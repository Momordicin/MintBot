import koffi from 'koffi'

// 启动门控（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"启动门控：重启后不要盲目相信
// home"一节，阶段②）。DisplayStateMap 纯内存、不跨应用重启存活，而 preferredDisplayId 跨
// 存活——应用重启的那一刻世界模型是空的、home 却是确定的，若 home 屏上此刻正跑着一个"当前
// 不是前台"的全屏程序（典型场景：用户从游戏 Alt-Tab 出来启动 MintBot），小人会直接落在它
// 上面，直到用户切回该程序才会被观察到、纠正过来。
//
// 本文件只放"是否应该不信任 home"这一个判断（纯函数，可单测）与获取该判断所需原始数据的
// 一次性 Win32 调用；真正"门控开着的时候不要落点/显示 Pet"的状态机（何时关、何时因为第一次
// external 观测或超时而开）在 windowBehavior.ts——跟 activeWindowMonitor.ts 里
// isFullscreenRect/classifyPidCheck（纯判断）与 getActiveWindowInfo/probeBlockerWindow
// （真实 Win32 调用）的拆分是同一个约定

const lib = process.platform === 'win32' ? koffi.load('shell32.dll') : null

// SHQueryUserNotificationState([out] QUERY_USER_NOTIFICATION_STATE *pquns) 返回 HRESULT——
// 32 位有符号整数，S_OK = 0 才代表 *pquns 有效。签名里没有任何显示器/窗口句柄参数，结构上
// 只能回答"整机此刻是否有东西在占据屏幕"，回答不了"哪块屏空闲"（那是主逻辑
// DisplayStateMap/resolver 的职责）；但启动这一刻需要的恰好是这个二元判断本身，见本文件
// 顶部注释
const SHQueryUserNotificationState = lib
  ? lib.func('int32_t __stdcall SHQueryUserNotificationState(_Out_ int32_t *pquns)')
  : null

// 与官方文档逐字核对过的三个"应判定为不信任 home"的状态值（完整枚举还有
// QUNS_NOT_PRESENT=1/QUNS_ACCEPTS_NOTIFICATIONS=5/QUNS_QUIET_TIME=6/QUNS_APP=7，均不触发
// 门控）：
const QUNS_BUSY = 2 // 一个全屏应用正在运行，或演示设置已启用
const QUNS_RUNNING_D3D_FULL_SCREEN = 3 // 全屏（独占模式）Direct3D 应用正在运行
const QUNS_PRESENTATION_MODE = 4 // 用户已激活 Windows 演示设置
const UNTRUSTED_STATES = new Set<number>([QUNS_BUSY, QUNS_RUNNING_D3D_FULL_SCREEN, QUNS_PRESENTATION_MODE])

// 三个状态同等对待、不区分——官方文档未说明无边框"伪全屏"游戏/浏览器 F11/全屏视频播放器
// 分别落到哪个状态，另有社区报告称独占全屏 D3D 实际常返回 QUNS_BUSY 而非更精确的
// QUNS_RUNNING_D3D_FULL_SCREEN（非微软官方确认的根因）。本门控把这三个状态同等对待，
// 上述不确定性因此不影响判定结果——这也是选择"三选一即触发"而非区分具体状态的原因
export function shouldDistrustHomeAtStartup(state: number | null): boolean {
  return state !== null && UNTRUSTED_STATES.has(state)
}

// 单次查询：只在启动时调用一次（官方文档：该 API 无事件、只能轮询；本用途只需要启动那一刻
// 的一次快照，不需要持续轮询）。调用失败/非 Windows 一律返回 null——
// shouldDistrustHomeAtStartup(null) 恒为 false，即调用失败时不额外阻塞启动，这跟
// activeWindowMonitor.ts 其它 Win32 绑定失败时的降级风格一致：宁可偶尔信任一个不该信任的
// home，也不要让启动门控本身的故障挡住小人永久不出现
export function queryUserNotificationState(): number | null {
  if (!SHQueryUserNotificationState) return null
  try {
    const stateBuf = [0]
    const hr = SHQueryUserNotificationState(stateBuf)
    if (hr !== 0) return null
    return stateBuf[0]
  } catch {
    return null
  }
}

// 门控超时：TDD 原文要求"必须有界，否则用户启动后若一直不切走窗口，小人会迟迟不出现"。
// 3000ms 的取值理由：前台轮询（500ms）与 blocker 复查（1500ms）这两条循环在这段时间内都
// 至少能各跑两轮，给"用户切回本就该被观察到的外部窗口"充分的机会；3 秒相对于应用启动
// 本身的耗时并不显眼，但足以避免"用户一直不切走、小人迟迟不出现"这种更差的体验。数值本身
// 没有比这更精确的论据，两头都不占优，是折衷选择——跟 foregroundWorldModel.ts 里 1500ms
// 校验间隔的选取方式一致
export const STARTUP_GATE_TIMEOUT_MS = 3000
