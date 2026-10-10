// src/electron-api.d.ts — 渲染进程里 window.electronAPI 的类型声明（preload 暴露的接口与桌宠状态载荷）
// 用法：渲染代码通过 window.electronAPI.* 调用：InputBar、ChatWindow、OverlayApp、CharacterPanel、WindowBehaviorPanel
// 对应文件：electron/preload/index.ts（contextBridge 实现）/ electron/main/index.ts（ipcMain 处理）
export interface DesktopPresencePayload {
  presence: 'ACTIVE' | 'AMBIENT' | 'EDGE' | 'HIDDEN'
  edgeSide: 'left' | 'right' | null
  handleSuppressed: boolean
}

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
  setOverlaySize: (size: { width: number; height: number }) => void
  onDesktopPresenceChanged: (callback: (payload: DesktopPresencePayload) => void) => () => void
  setTitlebarOverlay: (overlay: { color: string; symbolColor: string }) => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
