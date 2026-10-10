// electron/main/startupGate.ts — 启动时经 shell32 SHQueryUserNotificationState 查询用户是否处于忙碌 / D3D 全屏 / 演示模式，用于决定是否暂缓信任主显示器
// 用法：index.ts 在 app ready 时调 shouldDistrustHomeAtStartup(queryUserNotificationState())，为真则 closeStartupGate 并在 STARTUP_GATE_TIMEOUT_MS 后 openStartupGate；非 win32 查询返回 null
// 对应文件：electron/main/index.ts / electron/main/windowBehavior.ts（closeStartupGate / openStartupGate）/ electron/main/startupGate.test.ts
import koffi from 'koffi'

const lib = process.platform === 'win32' ? koffi.load('shell32.dll') : null

const SHQueryUserNotificationState = lib
  ? lib.func('int32_t __stdcall SHQueryUserNotificationState(_Out_ int32_t *pquns)')
  : null

const QUNS_BUSY = 2
const QUNS_RUNNING_D3D_FULL_SCREEN = 3
const QUNS_PRESENTATION_MODE = 4
const UNTRUSTED_STATES = new Set<number>([QUNS_BUSY, QUNS_RUNNING_D3D_FULL_SCREEN, QUNS_PRESENTATION_MODE])

export function shouldDistrustHomeAtStartup(state: number | null): boolean {
  return state !== null && UNTRUSTED_STATES.has(state)
}

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

export const STARTUP_GATE_TIMEOUT_MS = 3000
