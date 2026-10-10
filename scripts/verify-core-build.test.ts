// scripts/verify-core-build.test.ts
// 用途：验证 verifyCoreBuildCheck.mjs 的静态解析检查——能抽取各种形式的相对 specifier，坏路径会被报出，且从不执行被检查的模块
// 用法：vitest；产物目录用 os.tmpdir() 下的 mkdtemp 目录
// 对应方：scripts/verifyCoreBuildCheck.mjs、scripts/verify-core-build.mjs
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script without type declarations
import { extractRelativeSpecifiers, verifyCompiledImports } from './verifyCoreBuildCheck.mjs'

describe('extractRelativeSpecifiers', () => {
  it('覆盖 from / 副作用 import / 动态 import，忽略 bare 与 node: specifier', () => {
    const src = [
      `import a from './a.js'`,
      `export { b } from "../b.js"`,
      `import './side.js'`,
      `const c = await import('./c.js')`,
      `import fs from 'node:fs'`,
      `import x from 'fastify'`,
    ].join('\n')
    expect(extractRelativeSpecifiers(src).sort()).toEqual(['../b.js', './a.js', './c.js', './side.js'])
  })
})

describe('verifyCompiledImports', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mintbot-verify-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }

  it('全部解析得到：无错误，并统计 shared/ 引用；不执行模块', () => {
    write('shared/x.js', `export const x = 1`)
    write('services/core/a.js', `import { x } from '../../shared/x.js'\nthrow new Error('must not execute')`)
    return verifyCompiledImports(dir).then(r => {
      expect(r.errors).toEqual([])
      expect(r.sharedSpecifiers).toBe(1)
    })
  })

  it('坏的相对路径、缺扩展名、指向目录：都报错', async () => {
    write('shared/x.js', `export const x = 1`)
    write('services/core/a.js', `import { x } from '../../shared/missing.js'`)
    write('services/core/b.js', `import { x } from '../../shared/x'`)
    write('services/core/c.js', `import { x } from '../../shared'`)
    const r = await verifyCompiledImports(dir)
    expect(r.errors).toHaveLength(3)
  })

  it('带编码分隔符（%2F）的 specifier：记为错误，不抛异常', async () => {
    write('services/core/a.js', `import './x%2Fy.js'`)
    const r = await verifyCompiledImports(dir)
    expect(r.errors).toHaveLength(1)
  })

  it('跳过 *.test.js', async () => {
    write('services/core/a.test.js', `import './nope.js'`)
    expect((await verifyCompiledImports(dir)).errors).toEqual([])
  })
})
