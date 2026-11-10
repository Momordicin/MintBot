// services/core/roleConfig/confirm.ts — 一键生成角色配置的确认：整理用户确认的称呼列表，写入语音错写表草稿文件
// 用法：routes/roleConfig.ts 调 normalizeNames(value) 与 saveNamesDraft(presetId, names)
// 对应文件：services/core/routes/roleConfig.ts / services/core/voice/agent.ts
import fs from 'fs'
import path from 'path'
import { VOICE_DATA_DIR } from '../voice/agent.js'

export function normalizeNames(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return null
  const names = [...new Set(value.map(item => item.trim()).filter(item => item !== ''))]
  return names.length > 0 ? names : null
}

export async function saveNamesDraft(presetId: string, names: string[]): Promise<void> {
  await fs.promises.mkdir(VOICE_DATA_DIR, { recursive: true })
  const draft = { presetId, names, confirmedAt: Date.now() }
  await fs.promises.writeFile(path.join(VOICE_DATA_DIR, `names-draft-${presetId}.json`), JSON.stringify(draft, null, 2), 'utf-8')
}
