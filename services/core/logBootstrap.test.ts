// services/core/logBootstrap.test.ts
// 用途：验证 logBootstrap 先于 Fastify logger 构造时，pino 的行会进入日志文件，且它是 index.ts 的第一条 import
// 用法：vitest；在子进程里（去掉 VITEST，LOG_DIR 指向 os.tmpdir() 下的 mkdtemp 目录）先 import logBootstrap 再构造
//   Fastify({ logger: true })——pino 只在构造时检查 process.stdout 是否被改写
// 对应方：services/core/logBootstrap.ts、services/core/index.ts
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const bootstrapUrl = new URL('./logBootstrap.ts', import.meta.url).href

describe('logBootstrap', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mintbot-logboot-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('先装日志再构造 Fastify logger：pino 行与 console 输出都进入 core.log', () => {
    const script = [
      `import ${JSON.stringify(bootstrapUrl)}`,
      `import Fastify from 'fastify'`,
      `const f = Fastify({ logger: true })`,
      `f.log.info('pino-line-marker')`,
      `console.log('console-line-marker')`,
      `await new Promise(r => setTimeout(r, 200))`,
    ].join('\n')
    const env: NodeJS.ProcessEnv = { ...process.env, LOG_DIR: dir }
    delete env.VITEST
    const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: path.resolve(here, '..', '..'), env, encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    const log = fs.readFileSync(path.join(dir, 'core.log'), 'utf8')
    expect(log).toMatch(/info \[core\] .*pino-line-marker/)
    expect(log).toMatch(/info \[core\] console-line-marker/)
    expect(r.stdout).toContain('pino-line-marker')
  }, 30000)

  it('是 services/core/index.ts 的第一条 import', () => {
    const src = fs.readFileSync(path.join(here, 'index.ts'), 'utf8')
    expect(src.split(/\r?\n/).find(l => l.startsWith('import '))).toBe(`import './logBootstrap.js'`)
  })
})
