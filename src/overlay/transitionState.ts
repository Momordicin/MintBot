// src/overlay/transitionState.ts — 桌宠转场（唤醒/戳一下/入睡）的纯函数：选转场触发点、判断是否播放入睡转场、解析并展开转场链、决定当前显示哪张立绘
// 用法：OverlayApp 调用 selectTransitionTrigger、shouldPlayFallAsleep、parseTransitionChain（解析 GET /overlay/transition-chain 的响应）、resolveTransitionSteps、resolveOverlayDisplayFile
// 形状：TransitionTrigger = 'wake-from-sleep' | 'wake-from-bored' | 'poke-neutral' | 'fall-asleep'；转场链步骤 { files, durationMs, pick }
// 对应文件：src/overlay/OverlayApp.tsx / src/overlay/portraitState.ts / src/overlay/transitionState.test.ts / shared/transitionChain.ts / services/core/routes/transitionChain.ts

import { TRANSITION_PICKS, type TransitionChainStep } from '../../shared/transitionChain.js'
import {
  type OverlayManifest,
  type PortraitFormName,
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

export interface ResolvedTransitionStep {
  file: string
  durationMs: number
}

export function selectTransitionFile(step: TransitionChainStep, random: <T>(items: T[]) => T = pickRandom): string {
  switch (step.pick) {
    case 'random':
      return random(step.files)
  }
}

function isValidTransitionStep(step: unknown): step is TransitionChainStep {
  if (typeof step !== 'object' || step === null) return false
  const { files, durationMs, pick } = step as Record<string, unknown>
  return (
    Array.isArray(files) &&
    files.length > 0 &&
    files.every(file => typeof file === 'string' && file !== '') &&
    typeof durationMs === 'number' &&
    Number.isFinite(durationMs) &&
    durationMs > 0 &&
    (TRANSITION_PICKS as readonly unknown[]).includes(pick)
  )
}

export function parseTransitionChain(data: unknown): TransitionChainStep[] {
  if (typeof data !== 'object' || data === null) return []
  const { steps } = data as Record<string, unknown>
  if (!Array.isArray(steps) || !steps.every(isValidTransitionStep)) return []
  return steps
}

export function resolveTransitionSteps(chain: TransitionChainStep[]): ResolvedTransitionStep[] {
  return chain.map(step => ({ file: selectTransitionFile(step), durationMs: step.durationMs }))
}

export function resolveOverlayDisplayFile(
  manifest: OverlayManifest | undefined,
  form: PortraitFormName,
  transitionFile: string | null,
  isDragging: boolean,
  y: YState,
  x: string | undefined,
): string | null {
  if (transitionFile !== null) return transitionFile
  if (isDragging) {
    const dragFile = selectInteractionStateFile(manifest, form, 'drag')
    if (dragFile !== null) return dragFile
  }
  return resolveDisplayFile(manifest, form, y, x)
}
