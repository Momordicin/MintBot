// services/core/plugins/manager.ts — 可安装插件清单、启动时加载、安装与更新任务、版本检查与"仍然启用"、配置读写与整理，以及留给阶段 3 的 ToolContext 组装
// 用法：index.ts 的 start() 调 loadInstalledPlugins()；plugins/routes.ts 调 getPluginsSnapshot / fetchLatestVersion / startPluginInstall / savePluginConfig / forceEnablePlugin / cancelForceEnablePlugin；状态变化时 broadcastEvent('plugins-changed')；plugins/toolLoop.ts 每次聊天调 getEnabledTools，执行工具时调 createToolContext
// 对应文件：services/core/plugins/install.ts / services/core/plugins/package.ts / services/core/plugins/pluginFetch.ts / services/core/plugins/versionRange.ts / services/core/plugins/paths.ts / services/core/plugins/routes.ts / services/core/plugins/toolLoop.ts / services/core/events/broadcast.ts
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { pathToFileURL } from 'url'
import { ERROR_CODES, type ErrorCode } from '../../../shared/errorCodes.js'
import { broadcastEvent } from '../events/broadcast.js'
import { PluginDownloadError, downloadArchive, installArchive } from './install.js'
import {
  PluginPackageError,
  parsePluginPackage,
  type ConfigSchema,
  type PluginMetadata,
  type PluginStandard,
} from './package.js'
import { createPluginFetch, type PluginFetch } from './pluginFetch.js'
import { pluginConfigPath, pluginDataDir, pluginInstallDir, pluginOverridesPath } from './paths.js'
import { checkVersionRange } from './versionRange.js'

const LATEST_TIMEOUT_MS = 10_000

const PLUGIN_CATALOG = [
  {
    name: 'mintbot_weather',
    displayName: '天气',
    repo: 'https://github.com/Momordicin/mintbot-weather',
    branch: 'master',
  },
] as const

type CatalogEntry = (typeof PLUGIN_CATALOG)[number]

export interface ToolContext {
  config: Record<string, unknown>
  dataDir: string
  signal: AbortSignal
  fetch(url: string, init?: { headers?: Record<string, string> }): ReturnType<PluginFetch>
  log: { info(message: string): void; error(message: string): void }
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: object
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>
}

type DisabledReason =
  | { reason: 'version_incompatible'; range: string; mintbotVersion: string }
  | { reason: 'version_invalid'; range: string }
  | { reason: 'load_failed' }
  | { reason: 'load_failed'; forced: true; message: string }

interface LoadedPlugin {
  metadata: PluginMetadata
  tools: ToolDefinition[]
  config: Record<string, unknown>
  fetch: PluginFetch
}

interface PluginRecord {
  entry: CatalogEntry
  installed: boolean
  installedVersion: string | null
  schema: ConfigSchema | null
  loaded: LoadedPlugin | null
  disabled: DisabledReason | null
  forced: boolean
  status: { state: 'idle' | 'installing' | 'failed'; errorCode?: ErrorCode }
  needsRestart: boolean
}

export class PluginOperationError extends Error {
  constructor(readonly status: number, readonly errorCode: ErrorCode) {
    super(errorCode)
  }
}

const records = new Map<string, PluginRecord>(
  PLUGIN_CATALOG.map(entry => [
    entry.name,
    {
      entry,
      installed: false,
      installedVersion: null,
      schema: null,
      loaded: null,
      disabled: null,
      forced: false,
      status: { state: 'idle' },
      needsRestart: false,
    },
  ])
)

let installing = false

function notifyChanged(): void {
  broadcastEvent('plugins-changed', {})
}

function getRecord(name: string): PluginRecord {
  const record = records.get(name)
  if (!record) throw new PluginOperationError(404, ERROR_CODES.PLUGIN_NOT_FOUND)
  return record
}

function readMintbotVersion(): string {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'))
  return String(parsed.version)
}

function readDiskFile(directory: string, relativePath: string): Uint8Array | null {
  try {
    return fs.readFileSync(path.join(directory, relativePath))
  } catch {
    return null
  }
}

function defaultConfig(schema: ConfigSchema | null): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(schema ?? {})) {
    if (item && typeof item === 'object' && 'default' in item) config[key] = item.default
  }
  return config
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.tmp-${randomUUID()}`
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2))
    fs.renameSync(tempPath, filePath)
  } catch (err) {
    fs.rmSync(tempPath, { force: true })
    throw err
  }
}

function readConfig(name: string, schema: ConfigSchema | null): Record<string, unknown> {
  let text: string
  try {
    text = fs.readFileSync(pluginConfigPath(name), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultConfig(schema)
    throw err
  }
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('配置文件顶层不是对象')
  const stored = parsed as Record<string, unknown>
  if (schema === null) return stored

  const defaults = defaultConfig(schema)
  const normalized: Record<string, unknown> = {}
  let changed = false
  for (const key of Object.keys(schema)) {
    if (key in stored) normalized[key] = stored[key]
    else if (key in defaults) {
      normalized[key] = defaults[key]
      changed = true
    }
  }
  for (const key of Object.keys(stored)) {
    if (key in schema) continue
    changed = true
    console.log(`[Plugins] ${name} config key removed: ${key}`)
  }
  if (changed) writeJsonAtomic(pluginConfigPath(name), normalized)
  return normalized
}

type Overrides = Record<string, { forceEnabledVersion: string }>

function readOverrides(): Overrides {
  try {
    const parsed = JSON.parse(fs.readFileSync(pluginOverridesPath(), 'utf-8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Overrides
  } catch {
    return {}
  }
}

function forcedVersion(name: string): string | null {
  const version = readOverrides()[name]?.forceEnabledVersion
  return typeof version === 'string' ? version : null
}

function readTools(exported: unknown): ToolDefinition[] {
  const tools = (exported as { tools?: unknown } | null)?.tools
  if (!Array.isArray(tools)) throw new Error('入口文件没有导出 tools 数组')
  for (const tool of tools) {
    const candidate = tool as Partial<ToolDefinition> | null
    if (
      !candidate ||
      typeof candidate.name !== 'string' ||
      typeof candidate.description !== 'string' ||
      typeof candidate.parameters !== 'object' ||
      candidate.parameters === null ||
      typeof candidate.execute !== 'function'
    ) {
      throw new Error('tools 里有一项缺少 name、description、parameters 或 execute')
    }
  }
  return tools as ToolDefinition[]
}

async function loadPlugin(record: PluginRecord): Promise<void> {
  const { name } = record.entry
  const directory = pluginInstallDir(name)
  record.loaded = null
  record.disabled = null
  record.forced = false
  try {
    const { metadata, schema } = parsePluginPackage(relativePath => readDiskFile(directory, relativePath), name)
    record.installed = true
    record.installedVersion = metadata.version
    record.schema = schema

    const mintbotVersion = readMintbotVersion()
    const check = checkVersionRange(metadata.mintbot_version, mintbotVersion)
    if (check !== 'ok') {
      const range = metadata.mintbot_version as string
      if (forcedVersion(name) === metadata.version) {
        record.forced = true
        console.log(`[Plugins] ${name} ${metadata.version} version check overridden by the user (${range}, current ${mintbotVersion})`)
      } else if (check === 'invalid') {
        record.disabled = { reason: 'version_invalid', range }
        console.error(`[Plugins] ${name} not enabled: invalid mintbot_version "${range}"`)
        return
      } else {
        record.disabled = { reason: 'version_incompatible', range, mintbotVersion }
        console.error(`[Plugins] ${name} not enabled: requires MintBot ${range}, current ${mintbotVersion}`)
        return
      }
    }

    const config = readConfig(name, schema)
    const exported = await import(pathToFileURL(path.join(directory, metadata.entry)).href)
    const tools = readTools(exported)
    record.loaded = { metadata, tools, config, fetch: createPluginFetch(metadata.standard) }
    console.log(`[Plugins] ${name} ${metadata.version} enabled (${tools.length} tool(s))`)
  } catch (err) {
    if (record.forced) {
      const text = err instanceof Error ? err.message : String(err)
      record.disabled = { reason: 'load_failed', forced: true, message: text.split(/\r?\n/)[0].slice(0, 200) }
    } else {
      record.disabled = { reason: 'load_failed' }
    }
    console.error(`[Plugins] ${name} not enabled:`, err)
  }
}

export async function loadInstalledPlugins(): Promise<void> {
  for (const record of records.values()) {
    const directory = pluginInstallDir(record.entry.name)
    if (!fs.existsSync(directory)) continue
    record.installed = true
    await loadPlugin(record)
  }
}

export function createToolContext(name: string, signal: AbortSignal): ToolContext {
  const loaded = getRecord(name).loaded
  if (!loaded) throw new PluginOperationError(404, ERROR_CODES.PLUGIN_NOT_FOUND)
  const dataDir = pluginDataDir(name)
  fs.mkdirSync(dataDir, { recursive: true })
  const prefix = `[Plugin:${name}]`
  return {
    config: loaded.config,
    dataDir,
    signal,
    fetch: (url, init) => loaded.fetch(url, init, signal),
    log: {
      info: message => console.log(`${prefix} ${message}`),
      error: message => console.error(`${prefix} ${message}`),
    },
  }
}

export interface EnabledTool {
  pluginName: string
  displayName: string
  tool: ToolDefinition
  standard: PluginStandard
  config: Record<string, unknown>
}

export function getEnabledTools(): EnabledTool[] {
  const result: EnabledTool[] = []
  const seen = new Set<string>()
  for (const record of records.values()) {
    const loaded = record.loaded
    if (!loaded) continue
    for (const tool of loaded.tools) {
      if (seen.has(tool.name)) {
        console.error(`[Plugins] ${record.entry.name}: tool ${tool.name} skipped, the name is already provided by an earlier plugin`)
        continue
      }
      seen.add(tool.name)
      result.push({
        pluginName: record.entry.name,
        displayName: record.entry.displayName,
        tool,
        standard: loaded.metadata.standard,
        config: loaded.config,
      })
    }
  }
  return result
}

export function getPluginsSnapshot() {
  return [...records.values()].map(record => ({
    name: record.entry.name,
    displayName: record.entry.displayName,
    installed: record.installed,
    version: record.installedVersion,
    status: record.status,
    enabled: record.loaded !== null,
    disabled: record.disabled,
    forced: record.loaded !== null && record.forced,
    needsRestart: record.needsRestart,
    tools: record.loaded?.tools.map(tool => tool.name) ?? [],
    configSchema: record.schema,
    config: record.loaded?.config ?? null,
  }))
}

export async function fetchLatestVersion(name: string): Promise<string> {
  const { repo, branch } = getRecord(name).entry
  const url = `${repo.replace('https://github.com/', 'https://raw.githubusercontent.com/')}/${branch}/metadata.json`
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(LATEST_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const version = ((await response.json()) as { version?: unknown }).version
    if (typeof version !== 'string' || version === '') throw new Error('metadata.json 没有 version')
    return version
  } catch (err) {
    console.error(`[Plugins] ${name}: failed to read the latest version:`, err)
    throw new PluginOperationError(502, ERROR_CODES.PLUGIN_LATEST_FAILED)
  }
}

function installErrorCode(err: unknown): ErrorCode {
  if (err instanceof PluginDownloadError) return ERROR_CODES.PLUGIN_DOWNLOAD_FAILED
  if (err instanceof PluginPackageError) return ERROR_CODES.PLUGIN_PACKAGE_INVALID
  return ERROR_CODES.PLUGIN_INSTALL_FAILED
}

async function runInstall(record: PluginRecord): Promise<void> {
  const { name, repo, branch } = record.entry
  try {
    const archive = await downloadArchive(`${repo}/archive/refs/heads/${branch}.zip`)
    const { metadata, replaced } = await installArchive(name, archive)
    record.installed = true
    record.installedVersion = metadata.version
    if (replaced) record.needsRestart = true
    else await loadPlugin(record)
    record.status = { state: 'idle' }
    console.log(`[Plugins] ${name} ${metadata.version} installed${replaced ? ', restart required' : ''}`)
  } catch (err) {
    record.status = { state: 'failed', errorCode: installErrorCode(err) }
    console.error(`[Plugins] ${name} install failed:`, err)
  } finally {
    installing = false
    notifyChanged()
  }
}

export function startPluginInstall(name: string): void {
  const record = getRecord(name)
  if (installing) throw new PluginOperationError(409, ERROR_CODES.PLUGIN_BUSY)
  installing = true
  record.status = { state: 'installing' }
  notifyChanged()
  void runInstall(record)
}

export function savePluginConfig(name: string, input: unknown): void {
  const record = getRecord(name)
  if (!record.loaded || !record.schema) throw new PluginOperationError(404, ERROR_CODES.PLUGIN_NOT_FOUND)
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new PluginOperationError(400, ERROR_CODES.PLUGIN_CONFIG_INVALID)
  }
  const schema = record.schema
  for (const [key, value] of Object.entries(input)) {
    const item = schema[key]
    if (!item || typeof item !== 'object' || item.type !== 'string' || typeof value !== 'string') {
      throw new PluginOperationError(400, ERROR_CODES.PLUGIN_CONFIG_INVALID)
    }
  }

  const next = { ...defaultConfig(schema), ...(input as Record<string, unknown>) }
  writeJsonAtomic(pluginConfigPath(name), next)
  record.loaded.config = next
  notifyChanged()
}

export async function forceEnablePlugin(name: string): Promise<void> {
  const record = getRecord(name)
  if (record.status.state === 'installing') throw new PluginOperationError(409, ERROR_CODES.PLUGIN_BUSY)
  const reason = record.disabled?.reason
  if (!record.installed || record.installedVersion === null || (reason !== 'version_invalid' && reason !== 'version_incompatible')) {
    throw new PluginOperationError(409, ERROR_CODES.PLUGIN_FORCE_ENABLE_REJECTED)
  }
  writeJsonAtomic(pluginOverridesPath(), {
    ...readOverrides(),
    [name]: { forceEnabledVersion: record.installedVersion },
  })
  await loadPlugin(record)
  notifyChanged()
}

export async function cancelForceEnablePlugin(name: string): Promise<void> {
  const record = getRecord(name)
  if (record.status.state === 'installing') throw new PluginOperationError(409, ERROR_CODES.PLUGIN_BUSY)
  const disabled = record.disabled
  if (!record.installed || disabled?.reason !== 'load_failed' || !('forced' in disabled)) {
    throw new PluginOperationError(409, ERROR_CODES.PLUGIN_FORCE_ENABLE_REJECTED)
  }
  const { [name]: _removed, ...rest } = readOverrides()
  writeJsonAtomic(pluginOverridesPath(), rest)
  await loadPlugin(record)
  notifyChanged()
}
