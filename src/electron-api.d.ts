// electron/preload/index.ts 通过 contextBridge 暴露的 window.electronAPI 类型声明。
// 消费方：src/chat/ChatWindow.tsx（壁纸选择）、src/chat/InputBar.tsx（打开设置窗口）、
// src/settings/CharacterPanel.tsx（壁纸选择、角色卡导入选文件）、
// src/settings/WindowBehaviorPanel.tsx（选 exe 文件加入白名单/黑名单）、
// src/overlay/OverlayApp.tsx（点击悬浮窗恢复聊天窗口；订阅拖拽起止信号驱动转场锁与
// no-drag 切换，见 docs/MintBot_TDD.md §3.7 附「拖拽的实现方式」）。
// desktop-presence:changed 广播的负载（见 ElectronAPI.onDesktopPresenceChanged 定义处注释）。
// 导出这个类型，而不是把它内联写在下面的方法签名里，是为了让 electron/preload/index.ts 能
// 原样 import 同一个类型来标注它自己的 callback/listener 参数——两侧从此共享同一份类型声明，
// 而不是分别手写一份、靠人工保持同步（这正是 Fix 2 要关掉的那条"从未被编译器互相核对过"的缝）
export interface DesktopPresencePayload {
  presence: 'ACTIVE' | 'AMBIENT' | 'EDGE' | 'HIDDEN'
  edgeSide: 'left' | 'right' | null
  handleSuppressed: boolean
}

export interface ElectronAPI {
  platform: string
  selectWallpaperFile: () => Promise<{ data: Uint8Array<ArrayBuffer>; filename: string } | null>
  selectCharacterCardFile: () => Promise<{ data: Uint8Array<ArrayBuffer>; filename: string } | null>
  // 只需要文件名做白名单/黑名单匹配，不像壁纸/角色卡那样要把文件字节传回渲染层
  selectExeFile: () => Promise<{ filename: string } | null>
  openSettingsWindow: () => Promise<void>
  activateFromOverlay: () => void
  // 悬浮窗拖拽起止（主进程 hookWindowMessage 转发 WM_ENTERSIZEMOVE/WM_EXITSIZEMOVE，
  // 见 electron/main/windowDragMonitor.ts）：只在 win32 上触发，回调本身不携带任何数据。
  // 返回值是 unsubscribe 函数。这条 IPC 契约本身不变（Stage 3 起该文件同时也挂钩聊天窗口，
  // 但聊天窗口那一路只驱动主进程自己的 electron/main/dragActivity.ts，不转发 IPC）
  onOverlayDragStart: (callback: () => void) => () => void
  onOverlayDragEnd: (callback: () => void) => () => void
  // Stage 3 part 2（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"鼠标 hover Edge 可让角色
  // 临时展开"）：渲染层只上报"现在算不算 hover"，是否真的移动窗口由主进程
  // electron/main/windowBehavior.ts requestOverlayEdgeHover 决定（含"不是 EDGE 时忽略"这条
  // 守卫）
  requestOverlayEdgeHover: (hovered: boolean) => void
  // 悬浮窗渲染层挂载完成（含重载后重新挂载）时调用一次，换回当前 presence——调用方必须先
  // 用 onDesktopPresenceChanged 订阅、再调用这个，见 electron/main/windowBehavior.ts
  // sendCurrentPetPresenceOnReady 头注释里的竞态论证
  notifyOverlayReady: () => void
  // 悬浮窗 presence 广播：只在 presence/edgeSide/handleSuppressed 任一变化时下发一次（见
  // electron/main/windowBehavior.ts broadcastPetPresenceIfChanged），不是每次主进程 evaluate
  // 都发。edgeSide 只在 presence 为 'EDGE' 时非 null。presence/edgeSide 跟随 applied（窗口
  // 物理上已经落定的样子），handleSuppressed 是一条独立的安全门，同时读 latestDesired 与
  // applied（见 electron/main/desktopPresence.ts computeHandleSuppressed 定义处注释）——
  // 渲染层只应服从这个字段来决定是否抑制拖拽手柄，不应自己用 presence === 'EDGE' 重新推导
  // （那条推导现在只属于 main）。返回值是 unsubscribe，跟 onOverlayDragStart/onOverlayDragEnd
  // 同一套包法
  //
  // Fix 2（cleanup sweep，ts-backend-reviewer/integration-reviewer 各自发现"这条 wire 契约的
  // 两处声明——这里的字面量联合类型，与 electron/preload/index.ts 里同一个字段曾经手写的
  // `string`——从来没有被编译器互相核对过"）：DesktopPresencePayload 抽成本文件导出的一个
  // 具名类型，供 electron/preload/index.ts 原样导入使用，而不是各自手写一份形状相同的字面量。
  // 这个类型只覆盖"preload 声明的契约"与"preload 的实现"这一对——本文件顶部注释里列的其它
  // 消费方（如 src/overlay/OverlayApp.tsx）按既有约定各自维护自己的本地副本，不在这条修复的
  // 范围内，见该文件同名类型定义处注释
  onDesktopPresenceChanged: (callback: (payload: DesktopPresencePayload) => void) => () => void
  // 聊天窗口原生按钮条带配色，单向下发（无返回值），见 src/chat/themeVars.ts
  // titlebarOverlayFromTheme 与 electron/main/index.ts 的 'titlebar:set-overlay' 处理器
  setTitlebarOverlay: (overlay: { color: string; symbolColor: string }) => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
