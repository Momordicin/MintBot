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
  onDesktopPresenceChanged: (callback: (payload: DesktopPresencePayload) => void) => () => void
  setTitlebarOverlay: (overlay: { color: string; symbolColor: string }) => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
