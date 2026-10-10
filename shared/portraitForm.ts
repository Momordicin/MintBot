// shared/portraitForm.ts — 桌宠形态（像素/立绘）"是否可用"与"有效形态"的唯一判定，三处调用方共用
// 用途：一种形态可用 = 它的 fallback 指向的情绪组非空；有效形态 = 保存的形态可用就用它，否则用另一种可用的形态，都不可用则为 null
// 用法：services/core/characters/manifest.ts、src/overlay/OverlayApp.tsx、src/settings/CharacterPanel.tsx 从这里 import
// 配套文件：shared/portraitForm.test.ts / src/overlay/portraitState.ts

export type PortraitFormName = 'pixel' | 'illustration'

export interface PortraitFormShape {
  fallback?: string
  emotions?: Record<string, string[]>
}

export function isPortraitFormAvailable(form: PortraitFormShape | undefined): boolean {
  if (!form || !form.fallback) return false
  const group = form.emotions?.[form.fallback]
  return Array.isArray(group) && group.length > 0
}

export function resolveEffectiveForm(
  saved: PortraitFormName,
  portraits: Partial<Record<PortraitFormName, PortraitFormShape>> | undefined
): PortraitFormName | null {
  if (isPortraitFormAvailable(portraits?.[saved])) return saved
  const other: PortraitFormName = saved === 'pixel' ? 'illustration' : 'pixel'
  return isPortraitFormAvailable(portraits?.[other]) ? other : null
}
