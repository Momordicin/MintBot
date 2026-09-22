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
