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
