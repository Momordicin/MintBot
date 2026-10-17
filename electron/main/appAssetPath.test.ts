// electron/main/appAssetPath.test.ts — resolveAppAssetPath 的路径解析与越界防护测试
//
// 用法：pnpm test
// 配套文件：electron/main/appAssetPath.ts / electron/main/appOrigin.ts

import { describe, it, expect } from 'vitest'
import { resolve, sep } from 'path'
import { resolveAppAssetPath } from './appAssetPath'

const root = resolve('renderer-root')

function isInsideRoot(target: string | null): boolean {
  return target !== null && target.startsWith(root + sep)
}

describe('resolveAppAssetPath', () => {
  it('普通文件映射到根目录内', () => {
    expect(resolveAppAssetPath(root, 'app://mintbot/assets/main.js')).toBe(resolve(root, 'assets', 'main.js'))
  })

  it('结尾 / 映射到该目录的 index.html', () => {
    expect(resolveAppAssetPath(root, 'app://mintbot/')).toBe(resolve(root, 'index.html'))
    expect(resolveAppAssetPath(root, 'app://mintbot/settings/')).toBe(resolve(root, 'settings', 'index.html'))
  })

  it('忽略 query 与 hash', () => {
    expect(resolveAppAssetPath(root, 'app://mintbot/settings/index.html?x=1')).toBe(resolve(root, 'settings', 'index.html'))
    expect(resolveAppAssetPath(root, 'app://mintbot/settings/index.html#top')).toBe(resolve(root, 'settings', 'index.html'))
  })

  it('../ 被规范化后仍停留在根目录内', () => {
    expect(resolveAppAssetPath(root, 'app://mintbot/a/../b.js')).toBe(resolve(root, 'b.js'))
    expect(resolveAppAssetPath(root, 'app://mintbot/../../etc/passwd')).toBe(resolve(root, 'etc', 'passwd'))
  })

  it('编码的 ..%2F 越界返回 null', () => {
    expect(resolveAppAssetPath(root, 'app://mintbot/..%2F..%2Fsecret.txt')).toBeNull()
    expect(resolveAppAssetPath(root, 'app://mintbot/%2e%2e%2f%2e%2e%2fsecret.txt')).toBeNull()
  })

  it.runIf(process.platform === 'win32')('编码的反斜杠 ..%5C..%5C 越界返回 null（Windows）', () => {
    expect(resolveAppAssetPath(root, 'app://mintbot/..%5C..%5Csecret.txt')).toBeNull()
  })

  it('盘符路径 /C:/Windows/... 不会解析到根目录之外', () => {
    const result = resolveAppAssetPath(root, 'app://mintbot/C:/Windows/win.ini')
    expect(result === null || isInsideRoot(result)).toBe(true)
  })

  it('类 UNC 路径 //server/share 不会解析到根目录之外', () => {
    const result = resolveAppAssetPath(root, 'app://mintbot//server/share/file.txt')
    expect(result === null || isInsideRoot(result)).toBe(true)
  })

  it('%00 返回 null', () => {
    expect(resolveAppAssetPath(root, 'app://mintbot/a%00.js')).toBeNull()
  })

  it('错误的 host 返回 null', () => {
    expect(resolveAppAssetPath(root, 'app://evil/index.html')).toBeNull()
  })

  it('错误的 scheme 返回 null', () => {
    expect(resolveAppAssetPath(root, 'http://mintbot/index.html')).toBeNull()
    expect(resolveAppAssetPath(root, 'file://mintbot/index.html')).toBeNull()
  })
})
