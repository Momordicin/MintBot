// src/overlay/petMenu.ts — 桌宠右键菜单：由 overlay 渲染进程的当前状态生成菜单状态载荷，并把主进程转发回来的菜单动作核对后转成 PATCH 内容
// 用法：OverlayApp 右键时调 buildMenuState 经 electronAPI.openOverlayContextMenu 发给主进程；收到 onOverlayMenuAction 后调 resolveMenuActionPatch，非 null 才 PATCH /presets/:id
// 形状：buildMenuState({ presetId, form, manifest, petScale }) -> OverlayMenuState | null；resolveMenuActionPatch(action, live) -> { presetId, displayConfig } | null
// 对应文件：src/overlay/OverlayApp.tsx / src/overlay/petMenu.test.ts / src/overlay/portraitState.ts / src/electron-api.d.ts / shared/portraitForm.ts / electron/main/petContextMenu.ts / services/core/routes/presets.ts
import { isPortraitFormAvailable } from '../../shared/portraitForm.js'
import type { PetScale, PortraitFormName } from '../../shared/portraitForm.js'
import type { OverlayMenuAction, OverlayMenuState } from '../electron-api.js'
import type { OverlayManifest } from './portraitState.js'

export type PetScalePair = { pixel: PetScale; illustration: PetScale }

export interface PetMenuLive {
  presetId: string | null
  form: PortraitFormName
  manifest: OverlayManifest | undefined
  petScale: PetScalePair | null
}

export interface PetMenuPatch {
  presetId: string
  displayConfig: { petScale: PetScalePair } | { currentPortrait: PortraitFormName }
}

function otherForm(form: PortraitFormName): PortraitFormName {
  return form === 'pixel' ? 'illustration' : 'pixel'
}

export function buildMenuState(input: PetMenuLive): OverlayMenuState | null {
  const { presetId, form, manifest, petScale } = input
  if (!presetId || !manifest || !petScale) return null
  return {
    presetId,
    effectiveForm: form,
    otherFormAvailable: isPortraitFormAvailable(manifest.portraits?.[otherForm(form)]),
    petScale,
  }
}

export function resolveMenuActionPatch(action: OverlayMenuAction, live: PetMenuLive): PetMenuPatch | null {
  if (!live.presetId || !live.manifest || !live.petScale) return null
  if (action.presetId !== live.presetId) return null
  if (action.kind === 'set-scale') {
    if (action.form !== live.form) return null
    return { presetId: live.presetId, displayConfig: { petScale: { ...live.petScale, [action.form]: action.value } } }
  }
  if (action.to === live.form) return null
  if (!isPortraitFormAvailable(live.manifest.portraits?.[action.to])) return null
  return { presetId: live.presetId, displayConfig: { currentPortrait: action.to } }
}
