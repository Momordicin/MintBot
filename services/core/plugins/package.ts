// services/core/plugins/package.ts — 解压插件源码包到内存，并检查其中的 metadata.json 与 _conf_schema.json
// 用法：install.ts 对下载的压缩包调 extractArchive + parsePluginPackage；manager.ts 启动时对已安装目录调 parsePluginPackage；不合格抛 PluginPackageError
// 对应文件：services/core/plugins/install.ts / services/core/plugins/manager.ts / services/core/plugins/plugins.test.ts
import path from 'path'
import { unzipSync } from 'fflate'

export class PluginPackageError extends Error {}

export interface PluginStandard {
  retries: number
  retry_delay_ms: number
  request_timeout_ms: number
  connect_attempt_timeout_ms: number
  call_timeout_ms: number
  max_repeat: number
  cache: string
  errors: Record<string, unknown>
}

export interface PluginMetadata {
  name: string
  version: string
  mintbot_version?: string
  entry: string
  standard: PluginStandard
}

export interface ConfigSchemaItem {
  description?: string
  type?: string
  hint?: string
  default?: unknown
}

export type ConfigSchema = Record<string, ConfigSchemaItem>

export interface ParsedPackage {
  metadata: PluginMetadata
  schema: ConfigSchema | null
}

const STANDARD_NUMBERS = [
  'retries',
  'retry_delay_ms',
  'request_timeout_ms',
  'connect_attempt_timeout_ms',
  'call_timeout_ms',
  'max_repeat',
] as const

export function safeRelativePath(raw: string): string | null {
  const unified = raw.replace(/\\/g, '/')
  if (unified === '' || unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) return null
  if (unified.split('/').includes('..')) return null
  const normalized = path.posix.normalize(unified)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return null
  return normalized.replace(/\/$/, '')
}

export function extractArchive(data: Uint8Array): Map<string, Uint8Array> {
  let raw: Record<string, Uint8Array>
  try {
    raw = unzipSync(data)
  } catch (err) {
    throw new PluginPackageError(`压缩包无法解压：${err instanceof Error ? err.message : String(err)}`)
  }

  const entries: { name: string; isDir: boolean; data: Uint8Array }[] = []
  for (const [rawName, content] of Object.entries(raw)) {
    const name = safeRelativePath(rawName)
    if (name === null) throw new PluginPackageError(`压缩包含有不安全的路径：${rawName}`)
    entries.push({ name, isDir: rawName.endsWith('/') || rawName.endsWith('\\'), data: content })
  }

  const firstSegments = new Set(entries.map(entry => entry.name.split('/')[0]))
  const hasTopLevelFile = entries.some(entry => !entry.isDir && !entry.name.includes('/'))
  const root = firstSegments.size === 1 && !hasTopLevelFile ? [...firstSegments][0] : null

  const files = new Map<string, Uint8Array>()
  for (const entry of entries) {
    if (entry.isDir) continue
    files.set(root === null ? entry.name : entry.name.slice(root.length + 1), entry.data)
  }
  return files
}

function decodeJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8').decode(bytes))
  } catch {
    throw new PluginPackageError(`${label} 不是合法的 JSON`)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

export function parsePluginPackage(read: (relativePath: string) => Uint8Array | null, expectedName: string): ParsedPackage {
  const metadataBytes = read('metadata.json')
  if (metadataBytes === null) throw new PluginPackageError('缺少 metadata.json')
  const raw = decodeJson(metadataBytes, 'metadata.json')
  if (!isPlainObject(raw)) throw new PluginPackageError('metadata.json 顶层不是对象')

  if (raw.name !== expectedName) throw new PluginPackageError(`metadata.json 的 name 应为 ${expectedName}`)
  for (const key of ['version', 'entry'] as const) {
    if (!nonEmptyString(raw[key])) throw new PluginPackageError(`metadata.json 的 ${key} 必须是非空字符串`)
  }
  if (raw.mintbot_version !== undefined && typeof raw.mintbot_version !== 'string') {
    throw new PluginPackageError('metadata.json 的 mintbot_version 必须是字符串')
  }
  const entry = safeRelativePath(raw.entry as string)
  if (entry === null) throw new PluginPackageError('metadata.json 的 entry 路径不合法')
  if (read(entry) === null) throw new PluginPackageError(`entry 指向的文件不存在：${entry}`)

  const standard = raw.standard
  if (!isPlainObject(standard)) throw new PluginPackageError('metadata.json 缺少 standard')
  for (const key of STANDARD_NUMBERS) {
    if (typeof standard[key] !== 'number' || !Number.isFinite(standard[key])) {
      throw new PluginPackageError(`standard.${key} 必须是数字`)
    }
  }
  if (typeof standard.cache !== 'string') throw new PluginPackageError('standard.cache 必须是字符串')
  if (!isPlainObject(standard.errors)) throw new PluginPackageError('standard.errors 必须是对象')

  let schema: ConfigSchema | null = null
  const schemaBytes = read('_conf_schema.json')
  if (schemaBytes !== null) {
    const parsed = decodeJson(schemaBytes, '_conf_schema.json')
    if (!isPlainObject(parsed)) throw new PluginPackageError('_conf_schema.json 顶层不是对象')
    schema = parsed as ConfigSchema
  }

  return {
    metadata: {
      name: raw.name as string,
      version: raw.version as string,
      mintbot_version: raw.mintbot_version as string | undefined,
      entry,
      standard: standard as unknown as PluginStandard,
    },
    schema,
  }
}
