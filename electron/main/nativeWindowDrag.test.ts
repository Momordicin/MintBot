import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { BrowserWindow } from 'electron'

// koffi 绑定在模块加载时按 process.platform 决定是否创建，所以每个用例先设平台、再 resetModules 后动态 import

const calls: string[] = []
const releaseCapture = vi.fn(() => {
  calls.push('ReleaseCapture')
  return true
})
const postMessageW = vi.fn((..._args: unknown[]) => {
  calls.push('PostMessageW')
  return true
})
const load = vi.fn(() => ({
  func: (signature: string) => (signature.includes('ReleaseCapture') ? releaseCapture : postMessageW)
}))
const decode = vi.fn(() => 'HWND_PTR')

vi.mock('koffi', () => ({ default: { load, decode } }))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

const handleBuffer = Buffer.alloc(8)

function makeWindow(destroyed: boolean): BrowserWindow {
  return {
    isDestroyed: () => destroyed,
    getNativeWindowHandle: () => handleBuffer
  } as unknown as BrowserWindow
}

async function loadModule() {
  vi.resetModules()
  return import('./nativeWindowDrag')
}

describe('startNativeWindowDrag', () => {
  beforeEach(() => {
    calls.length = 0
    vi.clearAllMocks()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
  })

  it('does nothing off win32', async () => {
    setPlatform('linux')
    const { startNativeWindowDrag } = await loadModule()
    startNativeWindowDrag(makeWindow(false))
    expect(load).not.toHaveBeenCalled()
    expect(decode).not.toHaveBeenCalled()
    expect(releaseCapture).not.toHaveBeenCalled()
    expect(postMessageW).not.toHaveBeenCalled()
  })

  it('releases capture then posts WM_SYSCOMMAND / SC_DRAGMOVE on win32', async () => {
    setPlatform('win32')
    const { startNativeWindowDrag } = await loadModule()
    startNativeWindowDrag(makeWindow(false))
    expect(calls).toEqual(['ReleaseCapture', 'PostMessageW'])
    expect(decode).toHaveBeenCalledWith(handleBuffer, 'void *')
    expect(postMessageW).toHaveBeenCalledWith('HWND_PTR', 0x0112, 0xf012, 0)
  })

  it('logs a warning when PostMessageW fails', async () => {
    setPlatform('win32')
    postMessageW.mockImplementationOnce(() => false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { startNativeWindowDrag } = await loadModule()
    startNativeWindowDrag(makeWindow(false))
    expect(warn).toHaveBeenCalledWith('[NativeWindowDrag] PostMessageW(WM_SYSCOMMAND, SC_DRAGMOVE) failed')
    warn.mockRestore()
  })

  it('does nothing for a destroyed window', async () => {
    setPlatform('win32')
    const { startNativeWindowDrag } = await loadModule()
    startNativeWindowDrag(makeWindow(true))
    expect(releaseCapture).not.toHaveBeenCalled()
    expect(postMessageW).not.toHaveBeenCalled()
  })
})
