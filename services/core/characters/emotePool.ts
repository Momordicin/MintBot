// services/core/characters/emotePool.ts — 按模型回复里的 emote tag 从角色表情池随机选一个表情文件
// 用法：routes/chat.ts 在回复完成、发送 message_done 前调 selectEmoteFile(tag, state.manifest)；tag 不在词表或无匹配条目返回 null
// 形状：(tag, CharacterManifest | null, pickRandom?) -> manifest.emotePool 中某条目的 file | null
// 对应文件：services/core/characters/manifest.ts（CharacterManifest）/ services/core/routes/chat.ts / services/core/characters/emotePool.test.ts
import type { CharacterManifest } from './manifest.js'

export function pickRandomDefault<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}

export function selectEmoteFile(
  tag: string | null,
  manifest: CharacterManifest | null,
  pickRandom: <T>(items: T[]) => T = pickRandomDefault
): string | null {
  if (!tag || !manifest) return null
  if (!manifest.emoteTagVocabulary.includes(tag)) return null

  const candidates = manifest.emotePool.filter(entry => entry.tags.includes(tag))
  if (candidates.length === 0) return null

  return pickRandom(candidates).file
}
