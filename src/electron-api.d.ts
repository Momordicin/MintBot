// electron/preload/index.ts 通过 contextBridge 暴露的 window.electronAPI 类型声明。
// 消费方：src/chat/ChatWindow.tsx（壁纸选择）、src/chat/InputBar.tsx（打开设置窗口）、
// src/settings/CharacterPanel.tsx（壁纸选择、角色卡导入选文件）、
// src/settings/WindowBehaviorPanel.tsx（选 exe 文件加入白名单/黑名单）、
// src/overlay/OverlayApp.tsx（点击悬浮窗恢复聊天窗口；订阅拖拽起止信号驱动转场锁与
// no-drag 切换，见 docs/MintBot_TDD.md §3.7 附「拖拽的实现方式」）。
export interface ElectronAPI {
  platform: string
  selectWallpaperFile: () => Promise<{ data: Uint8Array<ArrayBuffer>; filename: string } | null>
  selectCharacterCardFile: () => Promise<{ data: Uint8Array<ArrayBuffer>; filename: string } | null>
  // 只需要文件名做白名单/黑名单匹配，不像壁纸/角色卡那样要把文件字节传回渲染层
  selectExeFile: () => Promise<{ filename: string } | null>
  openSettingsWindow: () => Promise<void>
  activateFromOverlay: () => void
  // 悬浮窗拖拽起止（主进程 hookWindowMessage 转发 WM_ENTERSIZEMOVE/WM_EXITSIZEMOVE，
  // 见 electron/main/overlayDragMonitor.ts）：只在 win32 上触发，回调本身不携带任何数据。
  // 返回值是 unsubscribe 函数
  onOverlayDragStart: (callback: () => void) => () => void
  onOverlayDragEnd: (callback: () => void) => () => void
  // 聊天窗口原生按钮条带配色，单向下发（无返回值），见 src/chat/themeVars.ts
  // titlebarOverlayFromTheme 与 electron/main/index.ts 的 'titlebar:set-overlay' 处理器
  setTitlebarOverlay: (overlay: { color: string; symbolColor: string }) => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
