// shared/logFile.test.ts
// 用途：验证 shared/logFile.ts——行格式化、启动滚动、tee 透传、写文件失败降级、uncaughtExceptionMonitor、测试目录守卫
// 用法：vitest；所有日志目录都用 os.tmpdir() 下的 mkdtemp 目录，每个用例结束都会还原 process.stdout / stderr 的 write
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendLogLine,
  createLineFormatter,
  errorCode,
  installLogFile,
  rotateIfLarge,
  uninstallLogFile,
} from './logFile.js'

const FIXED = () => new Date('2026-01-02T03:04:05.000Z')
const STAMP = '2026-01-02T03:04:05.000Z'

describe('createLineFormatter', () => {
  it('给每一行加上 时间 级别 [来源] 前缀', () => {
    const fmt = createLineFormatter('info', 'core', FIXED)
    expect(fmt('a\nb\n')).toBe(`${STAMP} info [core] a\n${STAMP} info [core] b\n`)
  })

  it('去掉行尾的 \\r', () => {
    const fmt = createLineFormatter('error', 'core', FIXED)
    expect(fmt('a\r\nb\r\n')).toBe(`${STAMP} error [core] a\n${STAMP} error [core] b\n`)
  })

  it('末尾没有换行的半行：下一块接在同一行上，不重复加前缀', () => {
    const fmt = createLineFormatter('info', 'core', FIXED)
    expect(fmt('ab')).toBe(`${STAMP} info [core] ab`)
    expect(fmt('cd\nef')).toBe(`cd\n${STAMP} info [core] ef`)
    expect(fmt('\n')).toBe('\n')
    expect(fmt('gh\n')).toBe(`${STAMP} info [core] gh\n`)
  })

  it('空块输出空串，空行保留前缀', () => {
    const fmt = createLineFormatter('info', 'core', FIXED)
    expect(fmt('')).toBe('')
    expect(fmt('\n')).toBe(`${STAMP} info [core] \n`)
  })
})

describe('rotateIfLarge', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mintbot-logfile-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('超过阈值：改名为 .1 并覆盖已有的 .1', () => {
    const file = path.join(dir, 'x.log')
    fs.writeFileSync(file, '0123456789')
    fs.writeFileSync(`${file}.1`, 'old')
    expect(rotateIfLarge(file, 5)).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe('0123456789')
  })

  it('未超过阈值（含恰好等于）：不动', () => {
    const file = path.join(dir, 'x.log')
    fs.writeFileSync(file, '01234')
    expect(rotateIfLarge(file, 5)).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe('01234')
  })

  it('文件不存在：不抛', () => {
    expect(rotateIfLarge(path.join(dir, 'none.log'), 5)).toBe(false)
  })

  it('默认阈值 10 MB：稀疏的 10 MB + 1 字节会滚动', () => {
    const file = path.join(dir, 'big.log')
    fs.writeFileSync(file, '')
    fs.truncateSync(file, 10 * 1024 * 1024)
    expect(rotateIfLarge(file)).toBe(false)
    fs.truncateSync(file, 10 * 1024 * 1024 + 1)
    expect(rotateIfLarge(file)).toBe(true)
    expect(fs.existsSync(`${file}.1`)).toBe(true)
  })
})

describe('errorCode', () => {
  it('优先 code，其次 name，否则 unknown', () => {
    expect(errorCode(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe('ENOENT')
    expect(errorCode(new SyntaxError('secret sk-123'))).toBe('SyntaxError')
    expect(errorCode(null)).toBe('unknown')
  })
})

describe('installLogFile', () => {
  let dir: string
  let stdoutSpy: ReturnType<typeof vi.fn>
  let stderrSpy: ReturnType<typeof vi.fn>
  const realStdout = process.stdout.write
  const realStderr = process.stderr.write

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mintbot-logfile-'))
    stdoutSpy = vi.fn(() => 'stdout-result')
    stderrSpy = vi.fn(() => 'stderr-result')
    process.stdout.write = stdoutSpy as unknown as typeof process.stdout.write
    process.stderr.write = stderrSpy as unknown as typeof process.stderr.write
  })

  afterEach(() => {
    uninstallLogFile()
    process.stdout.write = realStdout
    process.stderr.write = realStderr
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const read = () => fs.readFileSync(path.join(dir, 'core.log'), 'utf8')

  it('stdout 记为 info、stderr 记为 error，终端输出原样透传并返回原返回值', () => {
    installLogFile({ dir, fileName: 'core.log', source: 'core' })
    const cb = () => {}
    const r1 = process.stdout.write('hello\n', 'utf8', cb)
    const r2 = process.stderr.write('boom\n')
    expect(r1).toBe('stdout-result')
    expect(r2).toBe('stderr-result')
    expect(stdoutSpy).toHaveBeenCalledWith('hello\n', 'utf8', cb)
    expect(stderrSpy).toHaveBeenCalledWith('boom\n')
    const lines = read().trimEnd().split('\n')
    expect(lines[0]).toMatch(/^\S+ info \[core\] hello$/)
    expect(lines[1]).toMatch(/^\S+ error \[core\] boom$/)
  })

  it('Buffer 块按 utf8 解码', () => {
    installLogFile({ dir, fileName: 'core.log', source: 'core' })
    process.stdout.write(Buffer.from('你好\n'))
    expect(read()).toMatch(/info \[core\] 你好\n$/)
  })

  it('目录不存在时递归创建，启动时对超大旧文件滚动', () => {
    const nested = path.join(dir, 'a', 'b')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(nested, 'core.log'), '0123456789')
    installLogFile({ dir: nested, fileName: 'core.log', source: 'core', maxBytes: 5 })
    expect(fs.readFileSync(path.join(nested, 'core.log.1'), 'utf8')).toBe('0123456789')
    process.stdout.write('x\n')
    expect(fs.readFileSync(path.join(nested, 'core.log'), 'utf8')).toMatch(/info \[core\] x\n$/)
  })

  it('重复安装是空操作：不会二次包装，也不会重复写入', () => {
    installLogFile({ dir, fileName: 'core.log', source: 'core' })
    const wrapped = process.stdout.write
    installLogFile({ dir, fileName: 'core.log', source: 'core' })
    expect(process.stdout.write).toBe(wrapped)
    process.stdout.write('once\n')
    expect(read().match(/once/g)).toHaveLength(1)
    expect(stdoutSpy).toHaveBeenCalledTimes(1)
  })

  it('appendLogLine 只写文件，不进终端', () => {
    installLogFile({ dir, fileName: 'core.log', source: 'core' })
    appendLogLine({ level: 'warn', source: 'overlay', text: 'a\nb' })
    expect(stdoutSpy).not.toHaveBeenCalled()
    expect(stderrSpy).not.toHaveBeenCalled()
    const lines = read().trimEnd().split('\n')
    expect(lines[0]).toMatch(/^\S+ warn \[overlay\] a$/)
    expect(lines[1]).toMatch(/^\S+ warn \[overlay\] b$/)
  })

  it('写文件失败：不抛、只经原始 stderr 报一次，之后不再写文件', () => {
    fs.mkdirSync(path.join(dir, 'core.log'))
    installLogFile({ dir, fileName: 'core.log', source: 'core' })
    expect(() => process.stdout.write('one\n')).not.toThrow()
    expect(() => process.stderr.write('two\n')).not.toThrow()
    expect(() => appendLogLine({ level: 'error', source: 'x', text: 'three' })).not.toThrow()
    const notices = stderrSpy.mock.calls.filter(c => String(c[0]).startsWith('[LogFile]'))
    expect(notices).toHaveLength(1)
    expect(stdoutSpy).toHaveBeenCalledTimes(1)
  })

  it('uncaughtExceptionMonitor：写入 origin 与 stack', () => {
    installLogFile({ dir, fileName: 'core.log', source: 'core' })
    process.emit('uncaughtExceptionMonitor', new Error('kaboom'), 'uncaughtException')
    expect(read()).toMatch(/error \[core\] uncaughtException: Error: kaboom\n\S+ error \[core\]\s+at /)
  })

  it('VITEST 下日志目录不在 os.tmpdir() 内：拒绝安装', () => {
    expect(() => installLogFile({ dir: path.resolve(process.cwd(), 'logs'), fileName: 'core.log', source: 'core' })).toThrow(/refusing log dir/)
    expect(process.stdout.write).toBe(stdoutSpy)
  })
})
