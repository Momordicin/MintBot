// services/core/plugins/versionRange.ts — 按 PEP 440 判断插件声明的 MintBot 版本范围（如 ">=1.0,<2"）
// 用法：manager.ts 的 loadPlugin 调 checkVersionRange(插件的 mintbot_version, MintBot 的 package.json version)，返回 'ok' | 'invalid' | 'incompatible'
// 对应文件：services/core/plugins/manager.ts / services/core/plugins/plugins.test.ts
import { satisfies, validRange } from '@renovatebot/pep440'

export type VersionCheck = 'ok' | 'invalid' | 'incompatible'

export function checkVersionRange(range: string | undefined, version: string): VersionCheck {
  if (range === undefined || range === '') return 'ok'
  if (!validRange(range)) return 'invalid'
  return satisfies(version, range, { prereleases: true }) ? 'ok' : 'incompatible'
}
