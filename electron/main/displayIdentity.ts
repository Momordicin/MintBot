// electron/main/displayIdentity.ts — 显示器稳定键：win32 上经 koffi 调 user32 取显示器的设备接口名（DeviceID）作键，查不到时退回 display.id
// 用法：windowPositions.ts 用 getStableDisplayKey(display) 生成按屏记录与主显示器的键、用 fallbackDisplayKey(id) 生成找不到显示器时的键；index.ts 的 handleDisplayTopologyChange 先调 clearStableDisplayKeyCache()；原生查询用 user32 的 MonitorFromPoint / GetMonitorInfoW / EnumDisplayDevicesW
// 形状：getStableDisplayKey(Electron.Display) -> string；selectStableDisplayKey(deviceId: string | null, displayId: number) -> string；fallbackDisplayKey(displayId) -> `id:${displayId}`
// 对应文件：electron/main/windowPositions.ts / electron/main/index.ts / electron/main/displayIdentity.test.ts
import koffi from 'koffi'
import { screen } from 'electron'

const user32 = process.platform === 'win32' ? koffi.load('user32.dll') : null

const POINT = user32 ? koffi.struct({ x: 'int32_t', y: 'int32_t' }) : null
const RECT = user32
  ? koffi.struct({
      left: 'int32_t',
      top: 'int32_t',
      right: 'int32_t',
      bottom: 'int32_t',
    })
  : null
const HMONITOR = user32 ? koffi.pointer(koffi.opaque()) : null

const MONITORINFOEXW =
  user32 && RECT
    ? koffi.struct({
        cbSize: 'uint32_t',
        rcMonitor: RECT,
        rcWork: RECT,
        dwFlags: 'uint32_t',
        szDevice: koffi.array('char16_t', 32),
      })
    : null

const DISPLAY_DEVICEW = user32
  ? koffi.struct({
      cb: 'uint32_t',
      DeviceName: koffi.array('char16_t', 32),
      DeviceString: koffi.array('char16_t', 128),
      StateFlags: 'uint32_t',
      DeviceID: koffi.array('char16_t', 128),
      DeviceKey: koffi.array('char16_t', 128),
    })
  : null

const MonitorFromPoint =
  user32 && POINT && HMONITOR ? user32.func('MonitorFromPoint', HMONITOR, [POINT, 'uint32_t']) : null
const GetMonitorInfoW =
  user32 && HMONITOR && MONITORINFOEXW
    ? user32.func('GetMonitorInfoW', 'bool', [HMONITOR, koffi.inout(koffi.pointer(MONITORINFOEXW))])
    : null
const EnumDisplayDevicesW =
  user32 && DISPLAY_DEVICEW
    ? user32.func('EnumDisplayDevicesW', 'bool', [
        'str16',
        'uint32_t',
        koffi.inout(koffi.pointer(DISPLAY_DEVICEW)),
        'uint32_t',
      ])
    : null

const MONITOR_DEFAULTTONULL = 0
const EDD_GET_DEVICE_INTERFACE_NAME = 1
const MONITORINFOEXW_SIZE = 104
const DISPLAY_DEVICEW_SIZE = 840

const keyCache = new Map<number, string>()

export function fallbackDisplayKey(displayId: number): string {
  return `id:${displayId}`
}

export function selectStableDisplayKey(deviceId: string | null, displayId: number): string {
  return deviceId ? deviceId : fallbackDisplayKey(displayId)
}

function trimAtNul(value: string): string {
  const end = value.indexOf('\0')
  return end === -1 ? value : value.slice(0, end)
}

function queryDeviceId(display: Electron.Display): string | null {
  if (!MonitorFromPoint || !GetMonitorInfoW || !EnumDisplayDevicesW) return null

  try {
    const center = screen.dipToScreenPoint({
      x: Math.round(display.bounds.x + display.bounds.width / 2),
      y: Math.round(display.bounds.y + display.bounds.height / 2),
    })
    const monitor = MonitorFromPoint({ x: center.x, y: center.y }, MONITOR_DEFAULTTONULL)
    if (!monitor) return null

    const monitorInfo = {
      cbSize: MONITORINFOEXW_SIZE,
      rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 },
      rcWork: { left: 0, top: 0, right: 0, bottom: 0 },
      dwFlags: 0,
      szDevice: '',
    }
    if (!GetMonitorInfoW(monitor, monitorInfo)) return null
    const deviceName = trimAtNul(monitorInfo.szDevice)
    if (!deviceName) return null

    const device = {
      cb: DISPLAY_DEVICEW_SIZE,
      DeviceName: '',
      DeviceString: '',
      StateFlags: 0,
      DeviceID: '',
      DeviceKey: '',
    }
    if (!EnumDisplayDevicesW(deviceName, 0, device, EDD_GET_DEVICE_INTERFACE_NAME)) return null
    const deviceId = trimAtNul(device.DeviceID)
    return deviceId || null
  } catch {
    return null
  }
}

export function getStableDisplayKey(display: Electron.Display): string {
  const cached = keyCache.get(display.id)
  if (cached !== undefined) return cached

  const key = selectStableDisplayKey(queryDeviceId(display), display.id)
  keyCache.set(display.id, key)
  return key
}

export function clearStableDisplayKeyCache(): void {
  keyCache.clear()
}
