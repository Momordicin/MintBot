
export const BOREDOM_THRESHOLD_MS = 15 * 60 * 1000
export const SLEEP_THRESHOLD_MS = 60 * 60 * 1000

export type YState = 'boredom-idle' | 'sleeping' | null

export interface PortraitForm {
  fallback: string
  emotions?: Record<string, string[]>
}

export interface OverlayManifest {
  portraits?: {
    pixel?: PortraitForm
  }
  reservedStates?: Record<string, string[]>
  interactionStates?: Record<string, string>
}

export function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}

export function deriveY(params: {
  lastAttentionAt: number | null
  explicitSleep: boolean
  now: number
}): YState {
  if (params.explicitSleep) return 'sleeping'
  if (params.lastAttentionAt === null) return null
  const elapsed = params.now - params.lastAttentionAt
  if (elapsed >= SLEEP_THRESHOLD_MS) return 'sleeping'
  if (elapsed >= BOREDOM_THRESHOLD_MS) return 'boredom-idle'
  return null
}

export function nextThresholdInstant(lastAttentionAt: number | null, now: number): number | null {
  if (lastAttentionAt === null) return null
  const boredomAt = lastAttentionAt + BOREDOM_THRESHOLD_MS
  if (now < boredomAt) return boredomAt
  const sleepAt = lastAttentionAt + SLEEP_THRESHOLD_MS
  if (now < sleepAt) return sleepAt
  return null
}

function selectXFile(pixel: PortraitForm | undefined, x: string | undefined): string | null {
  if (!pixel) return null
  const emotions = pixel.emotions ?? {}
  const candidates = (x ? emotions[x] : undefined) ?? emotions[pixel.fallback]
  if (!candidates || candidates.length === 0) return null
  return pickRandom(candidates)
}

function selectYFile(manifest: OverlayManifest, y: YState): string | null {
  if (y === null) return null
  const candidates = manifest.reservedStates?.[y]
  if (!candidates || candidates.length === 0) return null
  return pickRandom(candidates)
}

export function selectInteractionStateFile(manifest: OverlayManifest | undefined, key: string): string | null {
  return manifest?.interactionStates?.[key] ?? null
}

export function resolveDisplayFile(manifest: OverlayManifest | undefined, y: YState, x: string | undefined): string | null {
  if (!manifest) return null
  const yFile = y !== null ? selectYFile(manifest, y) : null
  if (yFile) return yFile
  return selectXFile(manifest.portraits?.pixel, x)
}
