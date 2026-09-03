// electron/preload/index.ts 通过 contextBridge 暴露的 window.electronAPI 类型声明。
// 消费方：src/chat/ChatWindow.tsx（壁纸选择）、src/chat/InputBar.tsx（打开设置窗口）、
// src/settings/CharacterPanel.tsx（壁纸选择、角色卡导入选文件）、
// src/settings/WindowBehaviorPanel.tsx（选 exe 文件加入白名单/黑名单）、
// src/overlay/OverlayApp.tsx（点击悬浮窗恢复聊天窗口）。
export interface ElectronAPI {
  platform: string
  selectWallpaperFile: () => Promise<{ data: Uint8Array<ArrayBuffer>; filename: string } | null>
  selectCharacterCardFile: () => Promise<{ data: Uint8Array<ArrayBuffer>; filename: string } | null>
  // 只需要文件名做白名单/黑名单匹配，不像壁纸/角色卡那样要把文件字节传回渲染层
  selectExeFile: () => Promise<{ filename: string } | null>
  openSettingsWindow: () => Promise<void>
  activateFromOverlay: () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
