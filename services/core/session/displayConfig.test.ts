import { describe, it, expect, vi } from 'vitest'
import { DEFAULT_DISPLAY_CONFIG, parseDisplayConfig } from './displayConfig.js'

describe('parseDisplayConfig', () => {
  it('raw 为 null（迁移前的旧行/从未写过的行）时返回全部默认值，不告警', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseDisplayConfig(null)).toEqual(DEFAULT_DISPLAY_CONFIG)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('JSON 解析失败时返回全部默认值并告警', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseDisplayConfig('{not valid json')).toEqual(DEFAULT_DISPLAY_CONFIG)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('完整合法对象原样使用', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({ chatBgRgb: [10, 20, 30], chatBgOpacity: 0.3 })
    expect(parseDisplayConfig(raw)).toEqual({ chatBgRgb: [10, 20, 30], chatBgOpacity: 0.3 })
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('chatBgRgb 缺失时回退默认值，chatBgOpacity 不受影响', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({ chatBgOpacity: 0.9 })
    expect(parseDisplayConfig(raw)).toEqual({ chatBgRgb: DEFAULT_DISPLAY_CONFIG.chatBgRgb, chatBgOpacity: 0.9 })
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('chatBgRgb 类型错误（非数组）时回退默认值', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({ chatBgRgb: 'red', chatBgOpacity: 0.5 })
    expect(parseDisplayConfig(raw).chatBgRgb).toEqual(DEFAULT_DISPLAY_CONFIG.chatBgRgb)
  })

  it('chatBgRgb 元素超出 0-255 范围时回退默认值', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({ chatBgRgb: [10, 20, 300], chatBgOpacity: 0.5 })
    expect(parseDisplayConfig(raw).chatBgRgb).toEqual(DEFAULT_DISPLAY_CONFIG.chatBgRgb)
  })

  it('chatBgRgb 元素为非整数时回退默认值', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({ chatBgRgb: [10, 20, 30.5], chatBgOpacity: 0.5 })
    expect(parseDisplayConfig(raw).chatBgRgb).toEqual(DEFAULT_DISPLAY_CONFIG.chatBgRgb)
  })

  it('chatBgOpacity 缺失时回退默认值，chatBgRgb 不受影响', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({ chatBgRgb: [1, 2, 3] })
    expect(parseDisplayConfig(raw)).toEqual({ chatBgRgb: [1, 2, 3], chatBgOpacity: DEFAULT_DISPLAY_CONFIG.chatBgOpacity })
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('chatBgOpacity 超出 0-1 范围时回退默认值', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({ chatBgRgb: [1, 2, 3], chatBgOpacity: 1.5 })
    expect(parseDisplayConfig(raw).chatBgOpacity).toBe(DEFAULT_DISPLAY_CONFIG.chatBgOpacity)
  })

  it('chatBgOpacity 类型错误（字符串）时回退默认值', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({ chatBgRgb: [1, 2, 3], chatBgOpacity: '0.5' })
    expect(parseDisplayConfig(raw).chatBgOpacity).toBe(DEFAULT_DISPLAY_CONFIG.chatBgOpacity)
  })
})
