// electron/preload/index.ts 通过 contextBridge 暴露的 window.electronAPI 类型声明。
// 消费方：src/chat/ChatWindow.tsx（壁纸选择）、src/chat/InputBar.tsx（打开设置窗口）、
// src/settings/CharacterPanel.tsx（壁纸选择、角色卡导入选文件）。
export interface ElectronAPI {
  platform: string
  selectWallpaperFile: () => Promise<{ data: Uint8Array<ArrayBuffer>; filename: string } | null>
  selectCharacterCardFile: () => Promise<{ data: Uint8Array<ArrayBuffer>; filename: string } | null>
  openSettingsWindow: () => Promise<void>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
