// electron/main/petContextMenu.ts — 桌宠右键菜单的项描述生成与 overlay:menu-state 载荷校验
// 用法：index.ts 在 overlay:context-menu IPC 与 overlay 窗口 system-context-menu 事件里调 buildPetMenu，把返回的描述转成 Electron Menu 并按 action 分派；overlay:menu-state IPC 用 parsePetMenuState 校验后缓存
// 形状：buildPetMenu(PetMode, WindowBehaviorConfig, PetMenuState | null) -> PetMenuItem[]；parsePetMenuState(unknown) -> PetMenuState | null
// 对应文件：electron/main/index.ts / electron/main/desktopPresence.ts / shared/portraitForm.ts / shared/windowBehavior.ts / electron/main/petContextMenu.test.ts
import { PET_SCALE_OPTIONS } from '../../shared/portraitForm.js'
import type { PetScale, PortraitFormName } from '../../shared/portraitForm.js'
import type { WindowBehaviorConfig } from '../../shared/windowBehavior.js'
import type { PetMode } from './desktopPresence'

export interface PetMenuState {
  presetId: string
  effectiveForm: PortraitFormName
  otherFormAvailable: boolean
  petScale: { pixel: PetScale; illustration: PetScale }
}

export type PetMenuAction =
  | { kind: 'set-click-through'; value: boolean }
  | { kind: 'set-scale'; value: PetScale }
  | { kind: 'set-avoidance'; value: boolean }
  | { kind: 'switch-form'; form: PortraitFormName }
  | { kind: 'set-collapsed'; value: boolean }

export interface PetMenuItem {
  label: string
  type?: 'checkbox' | 'radio'
  checked?: boolean
  enabled?: boolean
  action?: PetMenuAction
  submenu?: PetMenuItem[]
}

const FORM_LABEL: Record<PortraitFormName, string> = { pixel: '像素', illustration: '立绘' }

function isScale(value: unknown): value is PetScale {
  return PET_SCALE_OPTIONS.some(option => option === value)
}

export function parsePetMenuState(payload: unknown): PetMenuState | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (typeof record.presetId !== 'string' || record.presetId === '') return null
  if (record.effectiveForm !== 'pixel' && record.effectiveForm !== 'illustration') return null
  if (typeof record.otherFormAvailable !== 'boolean') return null
  const scale = record.petScale as Record<string, unknown> | null | undefined
  if (typeof scale !== 'object' || scale === null) return null
  if (!isScale(scale.pixel) || !isScale(scale.illustration)) return null
  return {
    presetId: record.presetId,
    effectiveForm: record.effectiveForm,
    otherFormAvailable: record.otherFormAvailable,
    petScale: { pixel: scale.pixel, illustration: scale.illustration },
  }
}

function formatScale(scale: PetScale): string {
  return `${Math.round(scale * 100)}%`
}

export function buildPetMenu(
  mode: PetMode,
  config: WindowBehaviorConfig,
  state: PetMenuState | null
): PetMenuItem[] {
  if (mode === 'collapsed') {
    return [{ label: '显示悬浮窗', action: { kind: 'set-collapsed', value: false } }]
  }

  const currentScale = state ? state.petScale[state.effectiveForm] : null
  const sizeItems: PetMenuItem[] = PET_SCALE_OPTIONS.map(option => ({
    label: formatScale(option),
    type: 'radio',
    checked: option === currentScale,
    enabled: state !== null,
    action: { kind: 'set-scale', value: option },
  }))

  let formItem: PetMenuItem
  if (!state) {
    formItem = { label: '切换形态', enabled: false }
  } else {
    const otherForm: PortraitFormName = state.effectiveForm === 'pixel' ? 'illustration' : 'pixel'
    formItem = state.otherFormAvailable
      ? { label: `切换至${FORM_LABEL[otherForm]}`, action: { kind: 'switch-form', form: otherForm } }
      : { label: `该角色没有${FORM_LABEL[otherForm]}`, enabled: false }
  }

  return [
    {
      label: '窗口可穿透',
      type: 'checkbox',
      checked: config.petClickThrough,
      action: { kind: 'set-click-through', value: !config.petClickThrough },
    },
    { label: '窗口大小', enabled: state !== null, submenu: sizeItems },
    {
      label: '桌宠智能避让',
      type: 'checkbox',
      checked: config.petAvoidanceEnabled,
      action: { kind: 'set-avoidance', value: !config.petAvoidanceEnabled },
    },
    formItem,
    { label: '隐藏悬浮窗', action: { kind: 'set-collapsed', value: true } },
  ]
}
