// electron/preload/index.ts — 渲染进程预加载脚本：经 contextBridge 暴露 window.electronAPI（文件选择、设置窗口、桌宠拖拽 / 贴边 / 存在状态、标题栏配色）
// 用法：electron/main/index.ts 创建聊天、overlay、设置窗口时作为 webPreferences.preload（构建产物 index.cjs）；渲染进程调 window.electronAPI.*
// 形状：暴露只读 platform 与各 electronAPI 方法；每个方法对应一个 ipcRenderer.invoke / send / on 通道，on 类方法返回取消监听函数
// 对应文件：electron/main/index.ts（ipcMain 处理端、拖拽事件发送端）/ electron/main/windowBehavior.ts（desktop-presence:changed 发送端）/ src/electron-api.d.ts / electron.vite.config.ts
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
  setOverlaySize: (size: { width: number; height: number }) => ipcRenderer.send('overlay:set-size', size),
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