
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

export interface TransitionCandidateStep {
  files: string[]
  durationMs: number
}

export interface ResolvedTransitionStep {
  file: string
  durationMs: number
}

export const TRANSITION_FETCH_TIMEOUT_MS = 3000
export const TRANSITION_IMAGE_TIMEOUT_MS = 5000

function isCandidateStep(value: unknown): value is TransitionCandidateStep {
  if (typeof value !== 'object' || value === null) return false
  const { files, durationMs } = value as { files?: unknown; durationMs?: unknown }
  return (
    Array.isArray(files) &&
    files.length > 0 &&
    files.every(file => typeof file === 'string') &&
    typeof durationMs === 'number' &&
    Number.isFinite(durationMs) &&
    durationMs > 0
  )
}

export function parseTransitionResponse(body: unknown): TransitionCandidateStep[] {
  const steps = (body as { steps?: unknown } | null)?.steps
  return Array.isArray(steps) ? steps.filter(isCandidateStep) : []
}

export function pickTransitionFiles(
  steps: TransitionCandidateStep[],
  pick: <T>(items: T[]) => T = pickRandom,
): ResolvedTransitionStep[] {
  return steps
    .filter(step => step.files.length > 0)
    .map(step => ({ file: pick(step.files), durationMs: step.durationMs }))
}

export function isTransitionLocked(inProgress: TransitionTrigger | null): boolean {
  return inProgress !== null && inProgress !== 'fall-asleep'
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
