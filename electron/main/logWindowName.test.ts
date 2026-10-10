// electron/main/logWindowName.test.ts
// 用途：验证 windowNameFromUrl 对 dev / 打包路径的分类，包括安装路径里带 /settings/ 目录的情况
// 对应方：electron/main/logWindowName.ts
import { describe, expect, it } from 'vitest'
import { windowNameFromUrl } from './logWindowName'

describe('windowNameFromUrl', () => {
  it('dev：按页面路径分类', () => {
    expect(windowNameFromUrl('http://localhost:18173/overlay/index.html')).toBe('overlay')
    expect(windowNameFromUrl('http://localhost:18173/settings/index.html')).toBe('settings')
    expect(windowNameFromUrl('http://localhost:18173/')).toBe('chat')
  })

  it('打包：file URL', () => {
    expect(windowNameFromUrl('file:///C:/Program%20Files/MintBot/resources/app/out/renderer/overlay/index.html')).toBe('overlay')
    expect(windowNameFromUrl('file:///C:/Program%20Files/MintBot/resources/app/out/renderer/settings/index.html')).toBe('settings')
    expect(windowNameFromUrl('file:///C:/Program%20Files/MintBot/resources/app/out/renderer/index.html')).toBe('chat')
  })

  it('安装路径里有名为 settings / overlay 的目录：不影响分类', () => {
    expect(windowNameFromUrl('file:///C:/settings/MintBot/out/renderer/index.html')).toBe('chat')
    expect(windowNameFromUrl('file:///C:/overlay/MintBot/out/renderer/settings/index.html')).toBe('settings')
    expect(windowNameFromUrl('file:///C:/settings/MintBot/out/renderer/overlay/index.html')).toBe('overlay')
  })

  it('查询串与 hash 不影响；空串或无法解析的 URL 归为 chat', () => {
    expect(windowNameFromUrl('http://localhost:18173/overlay/index.html?x=1#/settings/index.html')).toBe('overlay')
    expect(windowNameFromUrl('')).toBe('chat')
    expect(windowNameFromUrl('not a url')).toBe('chat')
  })
})
