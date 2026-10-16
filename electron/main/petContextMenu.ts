// electron/main/petContextMenu.ts — 桌宠右键菜单的项描述生成与 overlay:context-menu 载荷校验
// 用法：index.ts 在 overlay:context-menu IPC 里用 parsePetMenuState 校验渲染进程随请求发来的菜单状态，调 buildPetMenu 把返回的描述转成 Electron Menu；点击后窗口类 action 由 index.ts 处理，isForwardedPetMenuAction 判定的 action 转发回 overlay 渲染进程
// 形状：buildPetMenu(PetMode, WindowBehaviorConfig, PetMenuState | null) -> PetMenuItem[]；parsePetMenuState(unknown) -> PetMenuState | null；set-scale / switch-form 的 action 携带 presetId
// 对应文件：electron/main/index.ts / electron/main/desktopPresence.ts / electron/main/i18n.ts / shared/portraitForm.ts / shared/windowBehavior.ts / electron/main/petContextMenu.test.ts / src/overlay/petMenu.ts
import { PET_SCALE_OPTIONS } from '../../shared/portraitForm.js'
import type { PetScale, PortraitFormName } from '../../shared/portraitForm.js'
import type { WindowBehaviorConfig } from '../../shared/windowBehavior.js'
import type { PetMode } from './desktopPresence'
import { i18n } from './i18n'

export interface PetMenuState {
  presetId: string
  effectiveForm: PortraitFormName
  otherFormAvailable: boolean
  petScale: { pixel: PetScale; illustration: PetScale }
}

export type PetMenuAction =
  | { kind: 'set-click-through'; value: boolean }
  | { kind: 'set-scale'; presetId: string; form: PortraitFormName; value: PetScale }
  | { kind: 'set-avoidance'; value: boolean }
  | { kind: 'switch-form'; presetId: string; to: PortraitFormName }
  | { kind: 'set-collapsed'; value: boolean }

export type ForwardedPetMenuAction = Extract<PetMenuAction, { kind: 'set-scale' | 'switch-form' }>

export interface PetMenuItem {
  label: string
  type?: 'checkbox' | 'radio'
  checked?: boolean
  enabled?: boolean
  action?: PetMenuAction
  submenu?: PetMenuItem[]
}

function formLabel(form: PortraitFormName): string {
  return form === 'pixel' ? i18n.t('像素') : i18n.t('立绘')
}

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

export function isForwardedPetMenuAction(action: PetMenuAction): action is ForwardedPetMenuAction {
  return action.kind === 'set-scale' || action.kind === 'switch-form'
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
    return [{ label: i18n.t('显示悬浮窗'), action: { kind: 'set-collapsed', value: false } }]
  }

  const currentScale = state ? state.petScale[state.effectiveForm] : null
  const sizeItems: PetMenuItem[] = PET_SCALE_OPTIONS.map(option => ({
    label: formatScale(option),
    type: 'radio',
    checked: option === currentScale,
    enabled: state !== null,
    action: state
      ? { kind: 'set-scale', presetId: state.presetId, form: state.effectiveForm, value: option }
      : undefined,
  }))

  let formItem: PetMenuItem
  if (!state) {
    formItem = { label: i18n.t('切换形态'), enabled: false }
  } else {
    const otherForm: PortraitFormName = state.effectiveForm === 'pixel' ? 'illustration' : 'pixel'
    formItem = state.otherFormAvailable
      ? { label: i18n.t('切换至{{form}}', { form: formLabel(otherForm) }), action: { kind: 'switch-form', presetId: state.presetId, to: otherForm } }
      : { label: i18n.t('该角色没有{{form}}', { form: formLabel(otherForm) }), enabled: false }
  }

  return [
    {
      label: i18n.t('窗口可穿透'),
      type: 'checkbox',
      checked: config.petClickThrough,
      action: { kind: 'set-click-through', value: !config.petClickThrough },
    },
    { label: i18n.t('窗口大小'), enabled: state !== null, submenu: sizeItems },
    {
      label: i18n.t('桌宠智能避让'),
      type: 'checkbox',
      checked: config.petAvoidanceEnabled,
      action: { kind: 'set-avoidance', value: !config.petAvoidanceEnabled },
    },
    formItem,
    { label: i18n.t('隐藏悬浮窗'), action: { kind: 'set-collapsed', value: true } },
  ]
}
