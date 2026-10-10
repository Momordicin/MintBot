// shared/logFile.ts
// 用途：把进程的 stdout / stderr 复制一份写入本地日志文件（终端输出保持原样），并提供只写文件的 appendLogLine
//   与 uncaughtExceptionMonitor 记录；启动时按大小做一次滚动（超过 10 MB 改名为 <name>.1，覆盖旧的 .1）
// 用法：services/core/logBootstrap.ts 与 electron/main/logBootstrap.ts 在各自入口的第一条 import 里调用
//   installLogFile；Electron 主进程用 appendLogLine 记录渲染进程的 warning / error
// 形状：每行 `ISO时间 级别 [来源] 文本`；stdout 记为 info，stderr 记为 error；写文件用 appendFileSync，
//   因为 Windows 下每种停止方式都是强杀，异步写入会丢尾部；写文件失败只通过原始 stderr 报一次，之后不再写文件
// 脱敏：只处理写进文件的内容（终端输出不变），对 sk- 密钥、Bearer 令牌、api_key / authorization 的值打码；
//   按每次写入的块逐块处理，被拆在两个块里的密钥无法识别（已知限制）
// 创建日志目录或滚动失败：经原始 stderr 报一次并返回 null，不安装任何包装，程序照常运行（只有 VITEST 守卫会抛）
// 对应方：测试环境（VITEST）下只允许写入 os.tmpdir() 内，镜像 db / 资源 / 壁纸的测试隔离守卫
import fs from 'fs'
import os from 'os'
import path from 'path'
import { StringDecoder } from 'string_decoder'

export type LogLevel = 'info' | 'warn' | 'error'

export const MAX_LOG_BYTES = 10 * 1024 * 1024

const SK_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}/g
const BEARER_PATTERN = /\b(Bearer[ \t]+)[A-Za-z0-9._~+\/=-]{8,}/gi
const KEY_VALUE_PATTERN = /(["']?(?:api[_-]?key|authorization)["']?[ \t]*[:=][ \t]*)("[^"\r\n]*"?|'[^'\r\n]*'?|[^\s,;"'}&]+)/gi

export function redactSecrets(text: string): string {
  return text
    .replace(SK_KEY_PATTERN, 'sk-***')
    .replace(BEARER_PATTERN, '$1***')
    .replace(KEY_VALUE_PATTERN, (_match, prefix: string, value: string) => {
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : ''
      const closing = quote !== '' && value.length > 1 && value.endsWith(quote) ? quote : ''
      return `${prefix}${quote}***${closing}`
    })
}

export interface InstallLogFileOptions {
  dir: string
  fileName: string
  source: string
  maxBytes?: number
}

export interface LogLineInput {
  level: LogLevel
  source: string
  text: string
}

export function createLineFormatter(level: LogLevel, source: string, now: () => Date = () => new Date()) {
  let atLineStart = true
  return (chunk: string): string => {
    if (chunk === '') return ''
    const parts = chunk.split('\n')
    const endsWithNewline = parts[parts.length - 1] === ''
    if (endsWithNewline) parts.pop()
    let out = ''
    for (let i = 0; i < parts.length; i++) {
      const needsPrefix = i > 0 || atLineStart
      const text = parts[i].replace(/\r+$/, '')
      const terminated = i < parts.length - 1 || endsWithNewline
      out += (needsPrefix ? `${now().toISOString()} ${level} [${source}] ` : '') + text + (terminated ? '\n' : '')
    }
    atLineStart = endsWithNewline
    return out
  }
}

export function rotateIfLarge(filePath: string, maxBytes: number = MAX_LOG_BYTES): boolean {
  try {
    if (fs.statSync(filePath).size <= maxBytes) return false
    const rotated = `${filePath}.1`
    fs.rmSync(rotated, { force: true })
    fs.renameSync(filePath, rotated)
    return true
  } catch {
    return false
  }
}

interface Installed {
  filePath: string
  append(text: string): void
  restore(): void
}

let installed: Installed | null = null

export function errorCode(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown } | null
  if (typeof e?.code === 'string') return e.code
  if (typeof e?.name === 'string') return e.name
  return 'unknown'
}

export function installLogFile(options: InstallLogFileOptions): string | null {
  if (installed) return installed.filePath

  const dir = path.resolve(options.dir)
  if (process.env.VITEST && !dir.startsWith(os.tmpdir() + path.sep)) {
    throw new Error(`[LogFile] refusing log dir "${dir}" under vitest; it must resolve inside ${os.tmpdir()}`)
  }

  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write

  const filePath = path.join(dir, options.fileName)
  try {
    fs.mkdirSync(dir, { recursive: true })
    rotateIfLarge(filePath, options.maxBytes)
  } catch (err) {
    try {
      originalStderrWrite.call(process.stderr, `[LogFile] 无法准备日志目录，本次运行不写日志文件 ${dir} (${errorCode(err)})\n`)
    } catch {}
    return null
  }

  let failed = false
  const append = (text: string): void => {
    if (failed || text === '') return
    try {
      let safe: string
      try {
        safe = redactSecrets(text)
      } catch {
        safe = '[LogFile] 脱敏失败，该行已丢弃\n'
      }
      fs.appendFileSync(filePath, safe)
    } catch (err) {
      failed = true
      try {
        originalStderrWrite.call(process.stderr, `[LogFile] 写入日志文件失败，之后不再写入 ${filePath} (${errorCode(err)})\n`)
      } catch {}
    }
  }

  const tee = (stream: NodeJS.WriteStream, original: typeof process.stdout.write, level: LogLevel) => {
    const format = createLineFormatter(level, options.source)
    const decoder = new StringDecoder('utf8')
    stream.write = function (this: unknown, ...args: unknown[]): boolean {
      try {
        const chunk = args[0]
        const encoding = args[1]
        const decodedFromEncoding =
          typeof chunk === 'string' && typeof encoding === 'string' && /^(hex|base64|base64url)$/i.test(encoding)
        const raw = decodedFromEncoding ? Buffer.from(chunk as string, encoding as BufferEncoding) : chunk
        append(format(typeof raw === 'string' ? raw : decoder.write(Buffer.from(raw as Uint8Array))))
      } catch {}
      return (original as (...a: unknown[]) => boolean).apply(stream, args)
    } as typeof stream.write
  }
  tee(process.stdout, originalStdoutWrite, 'info')
  tee(process.stderr, originalStderrWrite, 'error')

  const onUncaught = (err: Error, origin: string): void => {
    append(createLineFormatter('error', options.source)(`${origin}: ${err?.stack ?? String(err)}\n`))
  }
  process.on('uncaughtExceptionMonitor', onUncaught)

  installed = {
    filePath,
    append,
    restore() {
      process.stdout.write = originalStdoutWrite
      process.stderr.write = originalStderrWrite
      process.off('uncaughtExceptionMonitor', onUncaught)
    },
  }
  return filePath
}

export function uninstallLogFile(): void {
  installed?.restore()
  installed = null
}

export function appendLogLine({ level, source, text }: LogLineInput): void {
  installed?.append(createLineFormatter(level, source)(text.endsWith('\n') ? text : `${text}\n`))
}
