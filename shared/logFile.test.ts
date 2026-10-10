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
  installLogFile,
  redactSecrets,
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

describe('redactSecrets', () => {
  it('sk- 密钥：保留前缀，其余打码；长度不足 16 的不动', () => {
    expect(redactSecrets('key sk-ant-api03-AbCdEf_1234567890xyz end')).toBe('key sk-*** end')
    expect(redactSecrets('openai sk-abcdefghijklmnop1234')).toBe('openai sk-***')
    expect(redactSecrets('pip install sk-learn and sk-123456789012345')).toBe('pip install sk-learn and sk-123456789012345')
    expect(redactSecrets('sk-1234567890123456')).toBe('sk-***')
  })

  it('Bearer 令牌', () => {
    expect(redactSecrets('Authorization: Bearer abc.DEF-123_456~x')).toBe('Authorization: *** ***')
    expect(redactSecrets('header bearer abcdefgh12345')).toBe('header bearer ***')
    expect(redactSecrets('the Bearer of bad news')).toBe('the Bearer of bad news')
  })

  it('api_key / apiKey / api-key / x-api-key / authorization 的值（三种写法），保留键名', () => {
    expect(redactSecrets('api_key=abc123')).toBe('api_key=***')
    expect(redactSecrets('apiKey: abc123, next')).toBe('apiKey: ***, next')
    expect(redactSecrets('x-api-key: abc123')).toBe('x-api-key: ***')
    expect(redactSecrets('API-KEY = abc123')).toBe('API-KEY = ***')
    expect(redactSecrets('{"apiKey": "abc 123", "n": 1}')).toBe('{"apiKey": "***", "n": 1}')
    expect(redactSecrets("authorization: 'abc 123'")).toBe("authorization: '***'")
    expect(redactSecrets('url?api_key=abc123&x=1')).toBe('url?api_key=***&x=1')
  })

  it('引号没闭合的值（被截断的错误体）：掩到行尾；闭合的只掩引号内并保留闭合引号', () => {
    expect(redactSecrets('{"api_key": "abc123 trunc…')).toBe('{"api_key": "***')
    expect(redactSecrets("authorization: 'abc 123")).toBe("authorization: '***")
    expect(redactSecrets('{"api_key": "abc", "n": 1}')).toBe('{"api_key": "***", "n": 1}')
    expect(redactSecrets("apiKey='abc' rest")).toBe("apiKey='***' rest")
    expect(redactSecrets('first line apiKey: "abc\nsecond line')).toBe('first line apiKey: "***\nsecond line')
  })

  it('非密钥内容不动', () => {
    expect(redactSecrets('authorization is required for this route')).toBe('authorization is required for this route')
    expect(redactSecrets('api key missing')).toBe('api key missing')
    expect(redactSecrets('plain text 你好')).toBe('plain text 你好')
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

  it('文件里的密钥被打码，终端收到的仍是原文；appendLogLine 与 monitor 同样打码', () => {
    installLogFile({ dir, fileName: 'core.log', source: 'core' })
    process.stdout.write('using sk-abcdefghijklmnop1234 and Bearer tok12345678 api_key=hunter2\n')
    appendLogLine({ level: 'error', source: 'overlay', text: 'x-api-key: renderersecret' })
    process.emit('uncaughtExceptionMonitor', new Error('boom apiKey=leaky'), 'uncaughtException')
    expect(stdoutSpy).toHaveBeenCalledWith('using sk-abcdefghijklmnop1234 and Bearer tok12345678 api_key=hunter2\n')
    const text = read()
    expect(text).toContain('using sk-*** and Bearer *** api_key=***')
    expect(text).toContain('x-api-key: ***')
    expect(text).toMatch(/uncaughtException: Error: boom apiKey=\*\*\*\n\S+ error \[core\]\s+at /)
    expect(text).not.toMatch(/abcdefghijklmnop1234|tok12345678|hunter2|renderersecret|leaky/)
  })

  it('带非 utf8 编码参数的字符串写入：文件里是解码后的文本，终端收到原参数', () => {
    installLogFile({ dir, fileName: 'core.log', source: 'core' })
    const hex = Buffer.from('hex 你好').toString('hex')
    const b64 = Buffer.from('b64 text').toString('base64')
    process.stdout.write(hex, 'hex')
    process.stdout.write('\n')
    process.stdout.write(b64, 'base64', () => {})
    process.stdout.write('\n')
    process.stdout.write('plain\n', 'utf8')
    expect(stdoutSpy.mock.calls[0]).toEqual([hex, 'hex'])
    expect(stdoutSpy.mock.calls[2][1]).toBe('base64')
    const text = read()
    expect(text).toMatch(/info \[core\] hex 你好\n/)
    expect(text).toMatch(/info \[core\] b64 text\n/)
    expect(text).toMatch(/info \[core\] plain\n/)
    expect(text).not.toContain(hex)
    expect(text).not.toContain(b64)
  })

  it('ucs2 / utf16le / latin1 等其他编码的字符串写入：文件里是原字符串，不含 NUL', () => {
    installLogFile({ dir, fileName: 'core.log', source: 'core' })
    process.stdout.write('ucs2 text\n', 'ucs2')
    process.stdout.write('utf16 text\n', 'utf16le')
    process.stdout.write('latin1 text\n', 'latin1')
    const text = read()
    expect(text).toMatch(/info \[core\] ucs2 text\n/)
    expect(text).toMatch(/info \[core\] utf16 text\n/)
    expect(text).toMatch(/info \[core\] latin1 text\n/)
    expect(text).not.toContain('\0')
  })

  it('目录无法创建：不抛、不改 process.stdout.write、只报一次', () => {
    const blocker = path.join(dir, 'blocker')
    fs.writeFileSync(blocker, 'file')
    const wrapped = process.stdout.write
    expect(installLogFile({ dir: path.join(blocker, 'logs'), fileName: 'core.log', source: 'core' })).toBeNull()
    expect(process.stdout.write).toBe(wrapped)
    expect(process.stderr.write).toBe(stderrSpy)
    expect(stderrSpy.mock.calls.filter(c => String(c[0]).startsWith('[LogFile]'))).toHaveLength(1)
    expect(() => appendLogLine({ level: 'error', source: 'x', text: 'y' })).not.toThrow()
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
