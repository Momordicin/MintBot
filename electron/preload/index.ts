import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  selectWallpaperFile: () => ipcRenderer.invoke('select-wallpaper-file'),
  selectCharacterCardFile: () => ipcRenderer.invoke('select-character-card-file'),
  selectExeFile: () => ipcRenderer.invoke('select-exe-file'),
  openSettingsWindow: () => ipcRenderer.invoke('open-settings-window'),
  activateFromOverlay: () => ipcRenderer.send('overlay:activate'),
  onOverlayDragStart: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('overlay:drag-start', listener)
    return () => ipcRenderer.removeListener('overlay:drag-start', listener)
  },
  onOverlayDragEnd: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('overlay:drag-end', listener)
    return () => ipcRenderer.removeListener('overlay:drag-end', listener)
  },
  requestOverlayEdgeHover: (hovered: boolean) => ipcRenderer.send('overlay:edge-hover', hovered),
  notifyOverlayReady: () => ipcRenderer.send('overlay:presence-ready'),
  onDesktopPresenceChanged: (callback: (payload: { presence: string; edgeSide: 'left' | 'right' | null; handleSuppressed: boolean }) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { presence: string; edgeSide: 'left' | 'right' | null; handleSuppressed: boolean }
    ) => callback(payload)
    ipcRenderer.on('desktop-presence:changed', listener)
    return () => ipcRenderer.removeListener('desktop-presence:changed', listener)
  },
  setTitlebarOverlay: (overlay: { color: string; symbolColor: string }) =>
    ipcRenderer.send('titlebar:set-overlay', overlay)
})