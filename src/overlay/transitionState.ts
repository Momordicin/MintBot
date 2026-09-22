
import {
  type OverlayManifest,
  type YState,
  pickRandom,
  resolveDisplayFile,
  selectInteractionStateFile,
} from './portraitState.js'

export type TransitionTrigger = 'wake-from-sleep' | 'wake-from-bored' | 'poke-neutral' | 'fall-asleep'

export function selectTransitionTrigger(previousY: YState): TransitionTrigger {
  if (previousY === 'sleeping') return 'wake-from-sleep'
  if (previousY === 'boredom-idle') return 'wake-from-bored'
  return 'poke-neutral'
}

export function shouldPlayFallAsleep(params: {
  calledByThresholdTimer: boolean
  previousY: YState
  nextY: YState
  explicitSleep: boolean
}): boolean {
  if (!params.calledByThresholdTimer) return false
  if (params.explicitSleep) return false
  return params.previousY !== 'sleeping' && params.nextY === 'sleeping'
}

interface ParsedTransitionStep {
  keys: string[]
  durationMs: number
}

function normalizeFromKeys(from: unknown): string[] {
  const entries: unknown[] = Array.isArray(from) ? from : from !== undefined ? [from] : []
  const prefix = 'emotions.'
  const keys: string[] = []
  for (const entry of entries) {
    if (typeof entry === 'string' && entry.startsWith(prefix) && entry.length > prefix.length) {
      keys.push(entry.slice(prefix.length))
    }
  }
  return keys
}

function parseTransitionSteps(manifest: OverlayManifest, trigger: TransitionTrigger): ParsedTransitionStep[] {
  const raw = manifest.transitions?.[trigger]
  if (!Array.isArray(raw)) return []

  const steps: ParsedTransitionStep[] = []
  for (const rawStep of raw) {
    if (typeof rawStep !== 'object' || rawStep === null) continue
    const durationMs = (rawStep as Record<string, unknown>).durationMs
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) continue

    const keys = normalizeFromKeys((rawStep as Record<string, unknown>).from)
    if (keys.length === 0) continue

    steps.push({ keys, durationMs })
  }
  return steps
}

export interface ResolvedTransitionStep {
  file: string
  durationMs: number
}

function resolveStepFile(manifest: OverlayManifest, keys: string[]): string | null {
  const emotions = manifest.portraits?.pixel?.emotions ?? {}
  const usableKeys = keys.filter(key => (emotions[key]?.length ?? 0) > 0)
  if (usableKeys.length === 0) return null
  return pickRandom(emotions[pickRandom(usableKeys)])
}

export function resolveTransitionChain(
  manifest: OverlayManifest | undefined,
  trigger: TransitionTrigger,
): ResolvedTransitionStep[] {
  if (!manifest) return []

  const parsedSteps = parseTransitionSteps(manifest, trigger)
  const resolved: ResolvedTransitionStep[] = []
  for (const step of parsedSteps) {
    const file = resolveStepFile(manifest, step.keys)
    if (file === null) continue
    resolved.push({ file, durationMs: step.durationMs })
  }
  return resolved
}

export function transitionEndInstant(steps: ResolvedTransitionStep[], startedAt: number): number {
  const totalMs = steps.reduce((sum, step) => sum + step.durationMs, 0)
  return startedAt + totalMs
}

export function isTransitionLocked(lockedUntil: number | null, now: number): boolean {
  return lockedUntil !== null && now < lockedUntil
}

export function resolveOverlayDisplayFile(
  manifest: OverlayManifest | undefined,
  transitionFile: string | null,
  isDragging: boolean,
  y: YState,
  x: string | undefined,
): string | null {
  if (transitionFile !== null) return transitionFile
  if (isDragging) {
    const dragFile = selectInteractionStateFile(manifest, 'drag')
    if (dragFile !== null) return dragFile
  }
  return resolveDisplayFile(manifest, y, x)
}
