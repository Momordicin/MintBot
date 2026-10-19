// src/electron-api.d.ts — 渲染进程里 window.electronAPI 的类型声明（preload 暴露的接口与桌宠状态载荷）
// 用法：渲染代码通过 window.electronAPI.* 调用：InputBar、ChatWindow、OverlayApp、CharacterPanel、WindowBehaviorPanel、GeneralPanel、handle/main.ts、i18n.ts
// 对应文件：electron/preload/index.ts（contextBridge 实现）/ electron/main/index.ts（ipcMain 处理）
export interface DesktopPresencePayload {
  presence: 'ACTIVE' | 'AMBIENT' | 'EDGE' | 'HIDDEN'
  edgeSide: 'left' | 'right' | null
  handleSuppressed: boolean
  collapsed: boolean
  clickThrough: boolean
}

export interface OverlayMenuState {
  presetId: string
  effectiveForm: 'pixel' | 'illustration'
  otherFormAvailable: boolean
  petScale: { pixel: 0.5 | 0.75 | 1 | 1.25 | 1.5; illustration: 0.5 | 0.75 | 1 | 1.25 | 1.5 }
}

export type OverlayMenuAction =
  | { kind: 'set-scale'; presetId: string; form: 'pixel' | 'illustration'; value: 0.5 | 0.75 | 1 | 1.25 | 1.5 }
  | { kind: 'switch-form'; presetId: string; to: 'pixel' | 'illustration' }

export interface ElectronAPI {
  platform: string
  selectWallpaperFile: () => Promise<{ data: Uint8Array<ArrayBuffer>; filename: string } | null>
  selectCharacterCardFile: () => Promise<{ data: Uint8Array<ArrayBuffer>; filename: string } | null>
  selectExeFile: () => Promise<{ filename: string } | null>
  openSettingsWindow: () => Promise<void>
  activateFromOverlay: () => void
  onOverlayDragStart: (callback: () => void) => () => void
  onOverlayDragEnd: (callback: () => void) => () => void
  requestOverlayEdgeHover: (hovered: boolean) => void
  notifyOverlayReady: () => void
  setOverlaySize: (size: { baseWidth: number; baseHeight: number; scale: 0.5 | 0.75 | 1 | 1.25 | 1.5 }) => void
  openOverlayContextMenu: (state: OverlayMenuState | null) => void
  onOverlayContextMenuRequested: (callback: () => void) => () => void
  onOverlayMenuAction: (callback: (action: OverlayMenuAction) => void) => () => void
  startOverlayDrag: () => void
  openPetHandleContextMenu: () => void
  onDesktopPresenceChanged: (callback: (payload: DesktopPresencePayload) => void) => () => void
  getUiLocale: () => Promise<'zh-CN' | 'en'>
  onUiLocaleChanged: (callback: (locale: 'zh-CN' | 'en') => void) => () => void
  getAutostart: () => Promise<{ available: boolean; enabled: boolean }>
  setAutostart: (enabled: boolean) => Promise<{ available: boolean; enabled: boolean }>
  openMicSettings: () => Promise<void>
  notifyChatReady: () => Promise<void>
  onChatShown: (callback: () => void) => () => void
  notifyChatPainted: () => void
  setTitlebarOverlay: (overlay: { color: string; symbolColor: string }) => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
