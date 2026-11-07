// services/core/plugins/install.ts — 下载插件源码包、检查后写入 plugins/{name}/（先写临时目录再改名替换，失败时旧版本保持原样）
// 用法：manager.ts 的安装流程调 downloadArchive(url) 与 installArchive(name, 压缩包字节)；下载失败抛 PluginDownloadError，包不合格抛 PluginPackageError
// 对应文件：services/core/plugins/package.ts / services/core/plugins/paths.ts / services/core/plugins/manager.ts / services/core/plugins/plugins.test.ts
import fs from 'node:fs/promises'
import path from 'path'
import { PLUGINS_DIR, pluginInstallDir } from './paths.js'
import { extractArchive, parsePluginPackage, type PluginMetadata } from './package.js'

const DOWNLOAD_TIMEOUT_MS = 60_000

export class PluginDownloadError extends Error {}

export async function downloadArchive(url: string): Promise<Uint8Array> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  } catch (err) {
    throw new PluginDownloadError(err instanceof Error ? err.message : String(err))
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function writeFiles(name: string, files: Map<string, Uint8Array>): Promise<{ replaced: boolean }> {
  const stamp = Date.now()
  const staging = path.join(PLUGINS_DIR, `.staging-${name}-${stamp}`)
  const old = path.join(PLUGINS_DIR, `.old-${name}-${stamp}`)
  const target = pluginInstallDir(name)
  let movedOld = false
  try {
    await fs.mkdir(staging, { recursive: true })
    for (const [relativePath, data] of files) {
      const destination = path.join(staging, relativePath)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.writeFile(destination, data)
    }
    if (await pathExists(target)) {
      await fs.rename(target, old)
      movedOld = true
    }
    await fs.rename(staging, target)
  } catch (err) {
    if (movedOld) {
      try {
        await fs.rm(target, { recursive: true, force: true })
        await fs.rename(old, target)
      } catch (restoreErr) {
        console.error(`[Plugins] ${name}: failed to restore the previous version from ${old}:`, restoreErr)
      }
    }
    throw err
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
  }
  if (movedOld) {
    await fs.rm(old, { recursive: true, force: true }).catch(err => {
      console.error(`[Plugins] ${name}: failed to remove the previous version at ${old}:`, err)
    })
  }
  return { replaced: movedOld }
}

export async function installArchive(
  name: string,
  archive: Uint8Array
): Promise<{ metadata: PluginMetadata; replaced: boolean }> {
  const files = extractArchive(archive)
  const { metadata } = parsePluginPackage(relativePath => files.get(relativePath) ?? null, name)
  const { replaced } = await writeFiles(name, files)
  return { metadata, replaced }
}
