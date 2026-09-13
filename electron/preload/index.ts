import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  selectWallpaperFile: () => ipcRenderer.invoke('select-wallpaper-file'),
  selectCharacterCardFile: () => ipcRenderer.invoke('select-character-card-file'),
  selectExeFile: () => ipcRenderer.invoke('select-exe-file'),
  openSettingsWindow: () => ipcRenderer.invoke('open-settings-window'),
  activateFromOverlay: () => ipcRenderer.send('overlay:activate'),
  // 悬浮窗拖拽起止（主进程 hookWindowMessage 转发，见 electron/main/windowDragMonitor.ts）：
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
  // Stage 3 part 2（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"鼠标 hover Edge 可让角色
  // 临时展开"）：渲染层只上报"现在算不算 hover"，真正决定要不要移动窗口由主进程的
  // electron/main/windowBehavior.ts requestOverlayEdgeHover 决定（含"不是 EDGE 时忽略"这条
  // 守卫），这里只单向转发，不需要返回值
  requestOverlayEdgeHover: (hovered: boolean) => ipcRenderer.send('overlay:edge-hover', hovered),
  // 悬浮窗渲染层挂载完成（含重载后重新挂载）时调用一次，换回当前 presence——调用方必须先
  // 用 onDesktopPresenceChanged 订阅、再调用这个，顺序不能反，见
  // electron/main/windowBehavior.ts sendCurrentPetPresenceOnReady 头注释里的竞态论证
  notifyOverlayReady: () => ipcRenderer.send('overlay:presence-ready'),
  // 悬浮窗 presence 广播（主进程 evaluatePetPresence 在 presence/edgeSide 变化时下发，见
  // electron/main/windowBehavior.ts broadcastPetPresenceIfChanged）：跟 onOverlayDragStart/
  // onOverlayDragEnd 同一套包法，只转发不改形状，返回 unsubscribe。
  //
  // ⚠️ 这里的 payload 形状是**手写**的，与 src/electron-api.d.ts 的 DesktopPresencePayload、
  // 以及 src/overlay/OverlayApp.tsx 里渲染层自己那份本地镜像，三者互不被编译器核对。
  // 曾经试过让 preload 直接 import 那个类型并加 satisfies ElectronAPI 来关掉这条缝，但那样
  // 需要让 electron 这个 tsconfig 项目引用 ../src（改构建图），而换来的只是关掉三条缝里的一条
  // ——真正的消费方是渲染层，它按既有约定仍然自己维护镜像。收益太窄、代价是构建图依赖，
  // 因此撤回。要真正解决，应当把这个契约放进 shared/（两端都已经引用它），作为一次单独的决定
  onDesktopPresenceChanged: (callback: (payload: { presence: string; edgeSide: 'left' | 'right' | null; handleSuppressed: boolean }) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { presence: string; edgeSide: 'left' | 'right' | null; handleSuppressed: boolean }
    ) => callback(payload)
    ipcRenderer.on('desktop-presence:changed', listener)
    return () => ipcRenderer.removeListener('desktop-presence:changed', listener)
  },
  // 聊天窗口原生按钮条带配色：渲染层用 src/chat/themeVars.ts titlebarOverlayFromTheme
  // 算好 { color, symbolColor } 后单向下发，主进程据此调用 win.setTitleBarOverlay()
  // （TDD §3.2.2「渲染层消费」路径 3、§3.7 附「聊天窗口 chrome 模型」）
  setTitlebarOverlay: (overlay: { color: string; symbolColor: string }) =>
    ipcRenderer.send('titlebar:set-overlay', overlay)
})