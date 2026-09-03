import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  selectWallpaperFile: () => ipcRenderer.invoke('select-wallpaper-file'),
  selectCharacterCardFile: () => ipcRenderer.invoke('select-character-card-file'),
  selectExeFile: () => ipcRenderer.invoke('select-exe-file'),
  openSettingsWindow: () => ipcRenderer.invoke('open-settings-window'),
  activateFromOverlay: () => ipcRenderer.send('overlay:activate')
})