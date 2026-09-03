import type { CharacterManifest } from './manifest.js'

// 默认随机挑选实现：Math.random() 驱动，供生产环境调用方不传第三个参数时使用。
// 测试可以注入确定性的 pickRandom（不依赖真实随机数），是本模块唯一暴露的"不确定性入口"。
export function pickRandomDefault<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}

// 表情包挑选机制（TDD §3.9「表情包挑选机制：模型选 tag，应用选文件」）：模型只挑 tag，
// 应用侧确定性地把 emotePool 过滤为 tags 包含该 tag 的子集，再随机取一个作为本轮实际附带
// 的表情。三种情况都按"本轮不附表情，不报错"降级，不区分对待：
//   1. tag 为 null（模型本轮没有输出 emote 字段，是预期中的常见情况）
//   2. manifest 为 null（角色包缺失/解析失败，见 Part A）
//   3. tag 不在 manifest.emoteTagVocabulary 词表内，或过滤后的候选子集为空
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
