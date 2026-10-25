// electron/preload/index.ts — 渲染进程预加载脚本：经 contextBridge 暴露 window.electronAPI（文件选择、设置窗口、桌宠拖拽 / 贴边 / 存在状态 / 右键菜单（含穿透手柄窗口）、标题栏配色、界面语言、开机自启、语音输入快捷键）
// 用法：electron/main/index.ts 创建聊天、overlay、设置窗口时作为 webPreferences.preload（构建产物 index.cjs）；渲染进程调 window.electronAPI.*
// 形状：暴露只读 platform 与各 electronAPI 方法；每个方法对应一个 ipcRenderer.invoke / send / on 通道，on 类方法返回取消监听函数
// 对应文件：electron/main/index.ts（ipcMain 处理端、拖拽事件发送端）/ electron/main/windowBehavior.ts（desktop-presence:changed 发送端）/ electron/main/index.ts（ui:get-locale 处理端、ui:locale-changed 发送端、autostart:get / autostart:set 处理端、voice-hotkeys:get / voice-hotkeys:set / voice-hotkeys:capture 处理端、chat:ready 处理端、chat:painted 接收端）/ electron/main/chatReveal.ts（chat:shown 发送端）/ src/electron-api.d.ts / electron.vite.config.ts
import { contextBridge, ipcRenderer } from 'electron'
import type { VoiceHotkeySetResult, VoiceHotkeysState } from '../../shared/voiceHotkeys.js'

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
  setOverlaySize: (size: { baseWidth: number; baseHeight: number; scale: number }) => ipcRenderer.send('overlay:set-size', size),
  openOverlayContextMenu: (state: {
    presetId: string
    effectiveForm: 'pixel' | 'illustration'
    otherFormAvailable: boolean
    petScale: { pixel: number; illustration: number }
  } | null) => ipcRenderer.send('overlay:context-menu', state),
  onOverlayContextMenuRequested: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('overlay:context-menu-requested', listener)
    return () => ipcRenderer.removeListener('overlay:context-menu-requested', listener)
  },
  onOverlayMenuAction: (callback: (action: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: unknown) => callback(action)
    ipcRenderer.on('overlay:menu-action', listener)
    return () => ipcRenderer.removeListener('overlay:menu-action', listener)
  },
  startOverlayDrag: () => ipcRenderer.send('overlay:start-drag'),
  openPetHandleContextMenu: () => ipcRenderer.send('pet-handle:context-menu'),
  onDesktopPresenceChanged: (callback: (payload: { presence: string; edgeSide: 'left' | 'right' | null; handleSuppressed: boolean; collapsed: boolean; clickThrough: boolean }) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { presence: string; edgeSide: 'left' | 'right' | null; handleSuppressed: boolean; collapsed: boolean; clickThrough: boolean }
    ) => callback(payload)
    ipcRenderer.on('desktop-presence:changed', listener)
    return () => ipcRenderer.removeListener('desktop-presence:changed', listener)
  },
  getUiLocale: (): Promise<'zh-CN' | 'en'> => ipcRenderer.invoke('ui:get-locale'),
  onUiLocaleChanged: (callback: (locale: 'zh-CN' | 'en') => void) => {
    const listener = (_event: Electron.IpcRendererEvent, locale: 'zh-CN' | 'en') => callback(locale)
    ipcRenderer.on('ui:locale-changed', listener)
    return () => ipcRenderer.removeListener('ui:locale-changed', listener)
  },
  getAutostart: (): Promise<{ available: boolean; enabled: boolean }> => ipcRenderer.invoke('autostart:get'),
  setAutostart: (enabled: boolean): Promise<{ available: boolean; enabled: boolean }> => ipcRenderer.invoke('autostart:set', enabled),
  openMicSettings: (): Promise<void> => ipcRenderer.invoke('voice:open-mic-settings'),
  getVoiceHotkeys: (): Promise<VoiceHotkeysState> => ipcRenderer.invoke('voice-hotkeys:get'),
  setVoiceHotkeys: (input: { listen?: string; transcribe?: string }): Promise<VoiceHotkeySetResult> => ipcRenderer.invoke('voice-hotkeys:set', input),
  setVoiceHotkeyCapture: (active: boolean): Promise<VoiceHotkeysState> => ipcRenderer.invoke('voice-hotkeys:capture', active),
  notifyChatReady: (): Promise<void> => ipcRenderer.invoke('chat:ready'),
  onChatShown: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('chat:shown', listener)
    return () => ipcRenderer.removeListener('chat:shown', listener)
  },
  notifyChatPainted: () => ipcRenderer.send('chat:painted'),
  setTitlebarOverlay: (overlay: { color: string; symbolColor: string }) =>
    ipcRenderer.send('titlebar:set-overlay', overlay)
})