// src/overlay/portraitState.ts — 桌宠立绘选择的纯函数：由最近互动时间推导无聊/睡眠状态，按形态、状态与情绪从 manifest 选立绘文件，按图片尺寸算悬浮窗大小
// 用法：OverlayApp 调用 deriveY、nextThresholdInstant（下次状态切换时刻）、fallbackFirstFile、computeOverlaySize；transitionState.ts 调用 resolveDisplayFile、selectInteractionStateFile、pickRandom
// 形状：OverlayManifest { portraits?: { pixel | illustration: { fallback, emotions?, interactionStates?, reservedStates? } } }；YState = 'boredom-idle' | 'sleeping' | null
// 对应文件：src/overlay/OverlayApp.tsx / src/overlay/transitionState.ts / src/overlay/portraitState.test.ts / shared/portraitForm.ts
import type { PortraitFormName } from '../../shared/portraitForm.js'

export const BOREDOM_THRESHOLD_MS = 15 * 60 * 1000
export const SLEEP_THRESHOLD_MS = 60 * 60 * 1000

export type YState = 'boredom-idle' | 'sleeping' | null

export type { PortraitFormName }

export const PIXEL_MAX_SIDE_PX = 132
export const ILLUSTRATION_MAX_HEIGHT_PX = 500

export interface PortraitForm {
  fallback: string
  emotions?: Record<string, string[]>
  interactionStates?: Record<string, string>
  reservedStates?: Record<string, string[]>
}

export interface OverlayManifest {
  portraits?: Partial<Record<PortraitFormName, PortraitForm>>
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

export function fallbackFirstFile(form: PortraitForm | undefined): string | null {
  return form?.emotions?.[form.fallback]?.[0] ?? null
}

function selectXFile(form: PortraitForm | undefined, x: string | undefined): string | null {
  if (!form) return null
  const candidates = x ? form.emotions?.[x] : undefined
  if (candidates && candidates.length > 0) return pickRandom(candidates)
  return fallbackFirstFile(form)
}

function selectYFile(form: PortraitForm | undefined, y: YState): string | null {
  if (y === null || !form) return null
  const candidates = form.reservedStates?.[y]
  if (candidates && candidates.length > 0) return pickRandom(candidates)
  return fallbackFirstFile(form)
}

export function selectInteractionStateFile(
  manifest: OverlayManifest | undefined,
  form: PortraitFormName,
  key: string,
): string | null {
  const portraitForm = manifest?.portraits?.[form]
  return portraitForm?.interactionStates?.[key] ?? fallbackFirstFile(portraitForm)
}

export function resolveDisplayFile(
  manifest: OverlayManifest | undefined,
  form: PortraitFormName,
  y: YState,
  x: string | undefined,
): string | null {
  const portraitForm = manifest?.portraits?.[form]
  if (y !== null) return selectYFile(portraitForm, y)
  return selectXFile(portraitForm, x)
}

export function computeOverlaySize(
  form: PortraitFormName,
  naturalWidth: number,
  naturalHeight: number,
): { width: number; height: number } {
  const scale = form === 'pixel'
    ? Math.min(1, PIXEL_MAX_SIDE_PX / Math.max(naturalWidth, naturalHeight))
    : Math.min(1, ILLUSTRATION_MAX_HEIGHT_PX / naturalHeight)
  return {
    width: Math.max(1, Math.round(naturalWidth * scale)),
    height: Math.max(1, Math.round(naturalHeight * scale)),
  }
}
