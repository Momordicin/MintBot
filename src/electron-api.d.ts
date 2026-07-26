// electron/preload/index.ts 通过 contextBridge 暴露的 window.electronAPI 类型声明。
// 目前唯一消费方是 src/chat/ChatWindow.tsx 的壁纸选择功能。
export interface ElectronAPI {
  platform: string
  selectWallpaperFile: () => Promise<{ data: Uint8Array; filename: string } | null>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
