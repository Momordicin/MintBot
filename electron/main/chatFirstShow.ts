// electron/main/chatFirstShow.ts — 聊天窗口首次显示的等待上限与是否显示的判定
// 用法：index.ts createWindow 在 chat:ready 或 CHAT_READY_TIMEOUT_MS 超时时调 shouldShowChatOnFirstReady(pendingShowChat, launchedByAutostart)
// 对应文件：electron/main/index.ts / electron/main/chatFirstShow.test.ts
export const CHAT_READY_TIMEOUT_MS = 3000

export function shouldShowChatOnFirstReady(pendingShowChat: boolean, launchedByAutostart: boolean): boolean {
  return pendingShowChat || !launchedByAutostart
}
