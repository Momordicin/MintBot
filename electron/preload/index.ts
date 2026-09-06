import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  selectWallpaperFile: () => ipcRenderer.invoke('select-wallpaper-file'),
  selectCharacterCardFile: () => ipcRenderer.invoke('select-character-card-file'),
  selectExeFile: () => ipcRenderer.invoke('select-exe-file'),
  openSettingsWindow: () => ipcRenderer.invoke('open-settings-window'),
  activateFromOverlay: () => ipcRenderer.send('overlay:activate'),
  // 悬浮窗拖拽起止（主进程 hookWindowMessage 转发，见 electron/main/overlayDragMonitor.ts）：
  // 包一层 listener 只转发调用，不把 ipcRenderer 或原始 event 对象交给渲染层；返回值是
  // unsubscribe，调用方按需在 useEffect 清理时调用
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
  // 聊天窗口原生按钮条带配色：渲染层用 src/chat/chromeColor.ts 算好 { color, symbolColor }
  // 后单向下发，主进程据此调用 win.setTitleBarOverlay()（TDD §3.2.2「渲染层消费」路径 3、
  // §3.7 附「聊天窗口 chrome 模型」）
  setTitlebarOverlay: (overlay: { color: string; symbolColor: string }) =>
    ipcRenderer.send('titlebar:set-overlay', overlay)
})