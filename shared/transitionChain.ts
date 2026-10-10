// shared/transitionChain.ts
// 用途：悬浮窗转场链的跨进程契约——core 一次性确认好整条链的可用素材，悬浮窗只在其中选取播放
// 用法：services/core 的 characters/transitionChain.ts 与 routes/transitionChain.ts、src/overlay/transitionState.ts 与 OverlayApp.tsx 从这里 import
// 对应方：services/core/routes/transitionChain.ts 提供 GET /overlay/transition-chain，src/overlay/OverlayApp.tsx 在触发转场时请求
export type TransitionForm = 'pixel' | 'illustration'
export type TransitionPick = 'random'

export interface TransitionChainStep {
  files: string[]
  durationMs: number
  pick: TransitionPick
}

export interface TransitionChainResponse {
  steps: TransitionChainStep[]
}

export const TRANSITION_FORMS: readonly TransitionForm[] = ['pixel', 'illustration']
export const TRANSITION_PICKS: readonly TransitionPick[] = ['random']
export const DEFAULT_TRANSITION_DURATION_MS = 3000
