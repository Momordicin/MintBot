// services/core/plugins/paths.ts — 插件根目录（PLUGINS_PATH）及其下安装目录、数据目录、配置文件、"仍然启用"记录文件、临时目录的路径
// 用法：install.ts / manager.ts 引用 PLUGINS_ROOT 与 plugin*Path；环境变量 PLUGINS_PATH，默认 ./data
// 对应文件：services/core/plugins/install.ts / services/core/plugins/manager.ts / vitest.setup.ts / services/core/plugins/plugins.test.ts
import path from 'path'
import os from 'os'
import * as dotenv from 'dotenv'

dotenv.config({ quiet: true })

export const PLUGINS_ROOT = path.resolve(process.cwd(), process.env.PLUGINS_PATH ?? './data')

if (process.env.VITEST && !PLUGINS_ROOT.startsWith(os.tmpdir() + path.sep)) {
  throw new Error(`[Plugins] refusing PLUGINS_PATH "${PLUGINS_ROOT}" under vitest; it must resolve inside ${os.tmpdir()}`)
}

export const PLUGINS_DIR = path.join(PLUGINS_ROOT, 'plugins')

export function pluginInstallDir(name: string): string {
  return path.join(PLUGINS_DIR, name)
}

export function pluginDataDir(name: string): string {
  return path.join(PLUGINS_ROOT, 'plugin_data', name)
}

export function pluginConfigPath(name: string): string {
  return path.join(PLUGINS_ROOT, 'config', `${name}_config.json`)
}

export function pluginOverridesPath(): string {
  return path.join(PLUGINS_ROOT, 'config', 'plugin_overrides.json')
}
