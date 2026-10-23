// electron/main/index.ts — Electron 主进程入口：app ready 后创建聊天窗口、桌宠 overlay 与托盘，注册 IPC，启动前台窗口监控与 core /events 订阅，will-quit 时收尾
// 用法：electron.vite.config.ts 的主进程 entry；注册 autostart:get / autostart:set；监听 second-instance；注册 app 协议 protocol.handle('app')；第一条 import 为 logBootstrap；注册 chat:ready（聊天窗口首次显示）/ chat:painted（聊天窗口唤起后淡入）；注册 ui:get-locale，向窗口发 ui:locale-changed；设置窗口按 open-settings-window IPC 按需创建；订阅 voice-type（textOutput）与 voice-status-changed（托盘「语音输入」）；显示器拓扑变化时 handleDisplayTopologyChange 先调 clearStableDisplayKeyCache()
// 对应文件：electron/preload/index.ts（暴露的 IPC 通道）/ electron/main/windowBehavior.ts / electron/main/petContextMenu.ts / electron/main/coreEventsConsumer.ts / electron/main/i18n.ts / electron/main/foregroundWorldModel.ts / electron/main/windowDragMonitor.ts / electron/main/nativeWindowDrag.ts / electron/main/petTopmostGuard.ts / electron/main/startupGate.ts / electron/main/displayIdentity.ts / electron/main/appOrigin.ts / electron/main/appAssetPath.ts / electron/main/coreProcess.ts / electron/main/autostart.ts / electron/main/chatFirstShow.ts / electron/main/chatReveal.ts / electron/main/textOutput.ts / electron/main/sendInput.ts / electron/main/voiceTray.ts / shared/voiceInputMode.ts / shared/windowBehavior.ts / shared/portraitForm.ts
import './logBootstrap'
import { app, BrowserWindow, Menu, Tray, clipboard, powerMonitor, ipcMain, dialog, screen, nativeImage, protocol, net, shell } from 'electron'
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron'
import { join, basename } from 'path'
import { pathToFileURL } from 'url'
import { readFile, stat } from 'fs/promises'
import { is } from '@electron-toolkit/utils'
import { startWindowDragMonitor } from './windowDragMonitor'
import { startNativeWindowDrag } from './nativeWindowDrag'
import { noteDragStart, noteDragEnd, clearDragState } from './dragActivity'
import { nextReconnectDelayMs, RECONNECT_BACKOFF_FLOOR_MS } from './reconnectBackoff'
import { EVENTS_CLIENT_TIMEOUT_MS } from './eventsGeneration'
import { createCoreEventsConsumer } from './coreEventsConsumer'
import { i18n, getMainLocale, readUiLanguage, setMainLanguage } from './i18n'
import type { UiLanguage } from '../../shared/uiLocale.js'
import { CORE_URL } from './coreUrl'
import { appendLogLine } from '../../shared/logFile.js'
import { windowNameFromUrl } from './logWindowName'
import { APP_ORIGIN } from './appOrigin'
import { resolveAppAssetPath } from './appAssetPath'
import { ensureCoreRunning, stopSpawnedCore } from './coreProcess'
import { hasAutostartFlag, legacyLoginItemOptions, loginItemOptions, shouldMigrateAutostart } from './autostart'
import { CHAT_READY_TIMEOUT_MS, shouldShowChatOnFirstReady } from './chatFirstShow'
import { notifyChatPainted, revealChat } from './chatReveal'
import type { ChatPinMode, WindowBehaviorConfig, WindowBehaviorSnapshot } from '../../shared/windowBehavior.js'
import {
  initWindowBehaviorConfig,
  applyWindowBehaviorSnapshot,
  getCachedWindowBehaviorConfig,
  evaluateDesktopPresence,
  prepareChatForShow,
  handleWindowMoved,
  markProgrammaticWindowPlacement,
  closeStartupGate,
  openStartupGate,
  invalidateStaleAppliedDisplayIds,
  markTopologySettle,
  requestOverlayEdgeHover,
  sendCurrentPetPresenceOnReady,
  applyOverlaySize,
  armPetSizeGate,
  cancelProgrammaticMoveOnDragStart,
  getCurrentPetMode,
  noteOverlayCreatedCollapsed,
  notePetShapeApplied,
  recheckPetShapeScale,
  setPetHandleWindow
} from './windowBehavior'
import { createPetHandleWindow, syncPetHandleBounds } from './petHandleWindow'
import { startPetTopmostGuard, stopPetTopmostGuard } from './petTopmostGuard'
import { buildPetMenu, isForwardedPetMenuAction, parsePetMenuState } from './petContextMenu'
import type { PetMenuAction, PetMenuItem, PetMenuState } from './petContextMenu'
import {
  queryUserNotificationState,
  shouldDistrustHomeAtStartup,
  STARTUP_GATE_TIMEOUT_MS
} from './startupGate'
import {
  startDesktopObservation,
  revalidateBlockersNow
} from './foregroundWorldModel'
import {
  getPreferredBounds,
  setPreferredBounds,
  getEffectiveHomeDisplay,
  clampBoundsToWorkArea,
  collapsedHandleBounds,
  computeDefaultBoundsForDisplay,
  COLLAPSED_SIZE,
  DEFAULT_WINDOW_SIZE
} from './windowPositions'
import type { Bounds } from './windowPositions'
import { clearStableDisplayKeyCache } from './displayIdentity'
import { PET_SCALE_OPTIONS } from '../../shared/portraitForm.js'
import type { VoiceInputMode } from '../../shared/voiceInputMode.js'
import { getForegroundExeName } from './activeWindowMonitor'
import { sendKeyInputs } from './sendInput'
import { createTextOutput } from './textOutput'
import { buildVoiceInputMenu, createVoiceTrayRefresher, VOICE_TRAY_UNAVAILABLE } from './voiceTray'
import type { VoiceTrayState } from './voiceTray'

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])

const RENDERER_ROOT = join(__dirname, '../renderer')

const isDevMode = is.dev && Boolean(process.env['ELECTRON_RENDERER_URL'])
const launchedByAutostart = hasAutostartFlag(process.argv)
const hasSingleInstanceLock = isDevMode || app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

let stopDesktopObservation: (() => void) | null = null

const handleDisplayTopologyChange = (): void => {
  clearStableDisplayKeyCache()
  markTopologySettle()
  revalidateBlockersNow()
  invalidateStaleAppliedDisplayIds()
  evaluateDesktopPresence(mainWindow, overlayWindow)
}

function startActiveWindowMonitoring(): void {
  if (stopDesktopObservation) return
  stopDesktopObservation = startDesktopObservation(
    observation => {
      if (observation.kind === 'external') openStartupGate()
    },
    () => evaluateDesktopPresence(mainWindow, overlayWindow)
  )
}

function stopActiveWindowMonitoring(): void {
  stopDesktopObservation?.()
  stopDesktopObservation = null
}

let tray: Tray | null = null
let isQuitting = false

function notifySystemEvent(type: 'lock-screen' | 'unlock-screen'): void {
  fetch(`${CORE_URL}/internal/system-event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type }),
  }).catch(() => {})
}

async function resolveCurrentAvatarUrl(): Promise<string | null> {
  const stateResponse = await fetch(`${CORE_URL}/state`)
  const state = await stateResponse.json()
  const characterId = state?.presetSnapshot?.characterId
  if (!characterId) return null

  const manifestResponse = await fetch(`${CORE_URL}/characters/${encodeURIComponent(characterId)}/manifest.json`)
  const manifest = await manifestResponse.json()
  const avatar = manifest?.avatar
  if (!avatar) return null

  const encodedAvatarPath = avatar.split('/').map(encodeURIComponent).join('/')
  return `${CORE_URL}/characters/${encodeURIComponent(characterId)}/${encodedAvatarPath}`
}

let iconGeneration = 0

async function applyIconFromCurrentPreset(): Promise<void> {
  const generation = ++iconGeneration
  try {
    const avatarUrl = await resolveCurrentAvatarUrl()
    if (!avatarUrl) return

    const response = await fetch(avatarUrl)
    const buffer = Buffer.from(await response.arrayBuffer())
    const image = nativeImage.createFromBuffer(buffer)
    if (generation !== iconGeneration) return
    mainWindow?.setIcon(image)
    overlayWindow?.setIcon(image)
    settingsWindow?.setIcon(image)
    tray?.setImage(image)
  } catch (err) {
    console.error('[Icon] Failed to apply icon from current preset:', err)
  }
}

const textOutput = createTextOutput({ sendInput: sendKeyInputs, getForegroundExeName, clipboard })

let voiceTrayState: VoiceTrayState = VOICE_TRAY_UNAVAILABLE

const VOICE_STATUS_FETCH_TIMEOUT_MS = 3000

const refreshVoiceTray = createVoiceTrayRefresher({
  fetchStatus: async () => {
    const response = await fetch(`${CORE_URL}/voice/status`, { signal: AbortSignal.timeout(VOICE_STATUS_FETCH_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`voice status responded ${response.status}`)
    return response.json()
  },
  apply: state => {
    voiceTrayState = state
    rebuildTrayMenu()
  },
})

async function handleVoiceInputModeClick(mode: VoiceInputMode): Promise<void> {
  try {
    const response = await fetch(`${CORE_URL}/voice/input-mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    })
    if (!response.ok) console.error('[Voice] Core rejected voice input mode change:', response.status)
  } catch (err) {
    console.error('[Voice] Failed to change voice input mode:', err)
  }
  await refreshVoiceTray()
}

const coreEventsConsumer = createCoreEventsConsumer({
  converge,
  onPresetSwitched: applyIconFromCurrentPreset,
  onWindowBehaviorChanged: snapshot => {
    applyWindowBehaviorSnapshot(snapshot, mainWindow, overlayWindow)
    rebuildTrayMenu()
  },
  onUiLanguageChanged: applyUiLanguage,
  onVoiceStatusChanged: () => {
    void refreshVoiceTray()
  },
  onVoiceType: text => textOutput.typeText(text),
  log: {
    generationChanged: () =>
      console.log('[Events] Core service generation changed — the core process restarted, this is not the same server process we were talking to before (diagnostic only, does not itself trigger a resync)'),
    helloHeartbeatParseError: err => console.error('[Events] Failed to parse hello/heartbeat event:', err),
    windowBehaviorParseError: err => console.error('[WindowBehavior] Failed to parse window-behavior-changed event:', err),
    uiLanguageParseError: err => console.error('[I18n] Failed to parse ui-language-changed event:', err),
    voiceTypeParseError: err => console.error('[Voice] Failed to parse voice-type event:', err),
    voiceTypeError: err => console.error('[Voice] Failed to type recognized text:', err),
  },
})

async function connectToCoreEvents(): Promise<boolean> {
  let didConnect = false

  const abortController = new AbortController()
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined
  const armWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer)
    watchdogTimer = setTimeout(() => abortController.abort(), EVENTS_CLIENT_TIMEOUT_MS)
  }

  try {
    const response = await fetch(`${CORE_URL}/events`, { signal: abortController.signal })
    const reader = response.body?.getReader()
    if (!reader) return false
    didConnect = true
    armWatchdog()

    coreEventsConsumer.onConnected()

    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      armWatchdog()
      coreEventsConsumer.onChunk(decoder.decode(value, { stream: true }))
    }
    return true
  } catch (err) {
    console.error('[Events] core event subscription failed:', err)
    return didConnect
  } finally {
    if (watchdogTimer) clearTimeout(watchdogTimer)
  }
}

function converge(): void {
  initWindowBehaviorConfig(mainWindow, overlayWindow).then(rebuildTrayMenu)
  void refreshVoiceTray()
  applyIconFromCurrentPreset()
}

let isShuttingDownCoreEventsLoop = false

let coreEventsReconnectTimer: NodeJS.Timeout | null = null

function waitForCoreEventsReconnect(delayMs: number): Promise<void> {
  return new Promise(resolve => {
    coreEventsReconnectTimer = setTimeout(() => {
      coreEventsReconnectTimer = null
      resolve()
    }, delayMs)
  })
}

async function subscribeToCoreEvents(): Promise<void> {
  let delayMs = RECONNECT_BACKOFF_FLOOR_MS
  while (!isShuttingDownCoreEventsLoop) {
    const connected = await connectToCoreEvents()
    if (isShuttingDownCoreEventsLoop) return

    if (connected) {
      delayMs = RECONNECT_BACKOFF_FLOOR_MS
    }
    console.log(`[Events] reconnecting to core in ${delayMs}ms`)

    await waitForCoreEventsReconnect(delayMs)
    if (isShuttingDownCoreEventsLoop) return

    if (!connected) {
      delayMs = nextReconnectDelayMs(delayMs)
    }
  }
}

async function patchWindowBehavior(partial: Partial<WindowBehaviorConfig>): Promise<void> {
  try {
    const response = await fetch(`${CORE_URL}/config/window-behavior`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    })
    if (!response.ok) {
      console.error('[WindowBehavior] Core rejected window behavior patch:', response.status)
      return
    }
    applyWindowBehaviorSnapshot((await response.json()) as WindowBehaviorSnapshot, mainWindow, overlayWindow)
  } catch (err) {
    console.error('[WindowBehavior] Failed to patch window behavior config:', err)
  }
}

function applyUiLanguage(language: UiLanguage): void {
  if (!setMainLanguage(language)) return
  rebuildTrayMenu()
  const locale = getMainLocale()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('ui:locale-changed', locale)
  }
}

async function refreshUiLanguage(): Promise<void> {
  applyUiLanguage(await readUiLanguage())
}

ipcMain.handle('ui:get-locale', () => getMainLocale())

function readAutostart(): { available: boolean; enabled: boolean } {
  if (isDevMode) return { available: false, enabled: false }
  const { path, args } = loginItemOptions(process.execPath, app.getAppPath())
  return { available: true, enabled: app.getLoginItemSettings({ path, args }).openAtLogin }
}

function migrateLegacyAutostart(): void {
  const legacy = app.getLoginItemSettings(legacyLoginItemOptions(process.execPath, app.getAppPath()))
  if (!shouldMigrateAutostart(isDevMode, legacy.openAtLogin)) return
  console.log('[Autostart] migrating legacy login item to unquoted app path argument')
  app.setLoginItemSettings({ openAtLogin: true, enabled: legacy.executableWillLaunchAtLogin, ...loginItemOptions(process.execPath, app.getAppPath()) })
}

ipcMain.handle('autostart:get', () => readAutostart())

ipcMain.handle('voice:open-mic-settings', () => shell.openExternal('ms-settings:privacy-microphone'))

ipcMain.handle('autostart:set', (_event, enabled: unknown) => {
  if (isDevMode) throw new Error('autostart-unavailable')
  if (typeof enabled !== 'boolean') throw new Error('invalid-autostart-value')
  app.setLoginItemSettings({ openAtLogin: enabled, ...loginItemOptions(process.execPath, app.getAppPath()) })
  return readAutostart()
})

let pendingShowChat = false
let chatFirstShown = false

function showChatWindow(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  const onScreen = win.isVisible() && !win.isMinimized()
  if (!onScreen && !prepareChatForShow(win)) return
  revealChat(win, () => {
    if (win.isMinimized()) win.restore()
    win.show()
  })
  evaluateDesktopPresence(mainWindow, overlayWindow)
  win.focus()
}

function requestShowChat(): void {
  if (mainWindow && chatFirstShown) showChatWindow()
  else pendingShowChat = true
}

let handleChatReady: ((event: IpcMainInvokeEvent) => void) | null = null

ipcMain.handle('chat:ready', event => {
  handleChatReady?.(event)
})

ipcMain.on('chat:painted', event => {
  notifyChatPainted(event.sender)
})

app.on('second-instance', () => requestShowChat())

function rebuildTrayMenu(): void {
  if (!tray) return
  const { chatPinMode: currentChatPinMode, petAvoidanceEnabled } = getCachedWindowBehaviorConfig()

  const menu = Menu.buildFromTemplate([
    {
      label: i18n.t('聊天窗口置顶'),
      submenu: [
        {
          label: i18n.t('始终'),
          type: 'radio',
          checked: currentChatPinMode === 'always',
          click: () => handleChatPinModeClick('always'),
        },
        {
          label: i18n.t('智能'),
          type: 'radio',
          checked: currentChatPinMode === 'smart',
          click: () => handleChatPinModeClick('smart'),
        },
        {
          label: i18n.t('关闭'),
          type: 'radio',
          checked: currentChatPinMode === 'off',
          click: () => handleChatPinModeClick('off'),
        },
      ],
    },
    {
      label: i18n.t('桌宠智能避让'),
      type: 'checkbox',
      checked: petAvoidanceEnabled,
      click: () => handlePetAvoidanceClick(!petAvoidanceEnabled),
    },
    buildVoiceInputMenu(voiceTrayState, mode => void handleVoiceInputModeClick(mode)),
    {
      label: i18n.t('打开聊天窗口'),
      click: () => requestShowChat(),
    },
    {
      label: i18n.t('退出'),
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
}

async function handleChatPinModeClick(chatPinMode: ChatPinMode): Promise<void> {
  await patchWindowBehavior({ chatPinMode })
  rebuildTrayMenu()
}

async function handlePetAvoidanceClick(petAvoidanceEnabled: boolean): Promise<void> {
  await patchWindowBehavior({ petAvoidanceEnabled })
  rebuildTrayMenu()
}

function createTray(): void {
  tray = new Tray(nativeImage.createEmpty())
  tray.on('double-click', () => requestShowChat())
  rebuildTrayMenu()
}

const WALLPAPER_MAX_BYTES = 10 * 1024 * 1024

const CHARACTER_CARD_MAX_BYTES = 5 * 1024 * 1024

const PRELOAD_PATH = join(__dirname, '../preload/index.cjs')

ipcMain.handle('select-wallpaper-file', async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner) return null
  const result = await dialog.showOpenDialog(owner, {
    properties: ['openFile'],
    filters: [{ name: i18n.t('图片'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
  })
  if (result.canceled || result.filePaths.length === 0) return null

  const filePath = result.filePaths[0]
  const { size } = await stat(filePath)
  if (size > WALLPAPER_MAX_BYTES) {
    throw new Error('file-too-large')
  }

  const buffer = await readFile(filePath)
  return { data: new Uint8Array(buffer), filename: basename(filePath) }
})

ipcMain.handle('select-character-card-file', async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner) return null
  const result = await dialog.showOpenDialog(owner, {
    properties: ['openFile'],
    filters: [{ name: i18n.t('角色卡'), extensions: ['json', 'png'] }]
  })
  if (result.canceled || result.filePaths.length === 0) return null

  const filePath = result.filePaths[0]
  const { size } = await stat(filePath)
  if (size > CHARACTER_CARD_MAX_BYTES) {
    throw new Error('file-too-large')
  }

  const buffer = await readFile(filePath)
  return { data: new Uint8Array(buffer), filename: basename(filePath) }
})

ipcMain.handle('select-exe-file', async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner) return null
  const result = await dialog.showOpenDialog(owner, {
    properties: ['openFile'],
    filters: [{ name: i18n.t('可执行文件'), extensions: ['exe'] }]
  })
  if (result.canceled || result.filePaths.length === 0) return null

  return { filename: basename(result.filePaths[0]) }
})

function positionOnChatDisplay(win: BrowserWindow): void {
  const display = mainWindow && !mainWindow.isDestroyed()
    ? screen.getDisplayMatching(mainWindow.getBounds())
    : screen.getPrimaryDisplay()
  const { x: workAreaX, y: workAreaY, width: workAreaWidth, height: workAreaHeight } = display.workArea
  const [winWidth, winHeight] = win.getSize()
  win.setPosition(
    Math.round(workAreaX + (workAreaWidth - winWidth) / 2),
    Math.round(workAreaY + (workAreaHeight - winHeight) / 2)
  )
}

let settingsWindow: BrowserWindow | null = null

function createSettingsWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 760,
    height: 560,
    show: false,
    parent: mainWindow ?? undefined,
    webPreferences: {
      preload: PRELOAD_PATH
    }
  })

  positionOnChatDisplay(win)

  win.on('ready-to-show', () => {
    win.show()
  })

  win.on('closed', () => {
    settingsWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/settings/index.html`)
  } else {
    win.loadURL(`${APP_ORIGIN}/settings/index.html`)
  }

  return win
}

ipcMain.handle('open-settings-window', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    positionOnChatDisplay(settingsWindow)
    if (settingsWindow.isMinimized()) {
      settingsWindow.restore()
    }
    settingsWindow.show()
    settingsWindow.focus()
    return
  }
  settingsWindow = createSettingsWindow()
  applyIconFromCurrentPreset()
})

let overlayWindow: BrowserWindow | null = null
let petHandleWindow: BrowserWindow | null = null

function resolveOverlayStartupBounds(): Bounds {
  const displays = screen.getAllDisplays()
  const targetDisplay = getEffectiveHomeDisplay(displays, 'overlay')
  const stored = getPreferredBounds('overlay', targetDisplay.id)
  const bounds = stored
    ? clampBoundsToWorkArea(stored, targetDisplay.workArea)
    : computeDefaultBoundsForDisplay(targetDisplay, displays, DEFAULT_WINDOW_SIZE.overlay, 'overlay')
  if (!stored) {
    setPreferredBounds('overlay', targetDisplay.id, bounds)
  }
  return getCachedWindowBehaviorConfig().petCollapsed ? collapsedHandleBounds(bounds) : bounds
}

function toMenuTemplate(items: PetMenuItem[]): MenuItemConstructorOptions[] {
  return items.map(item => {
    const option: MenuItemConstructorOptions = { label: item.label }
    if (item.type) option.type = item.type
    if (item.checked !== undefined) option.checked = item.checked
    if (item.enabled !== undefined) option.enabled = item.enabled
    if (item.submenu) option.submenu = toMenuTemplate(item.submenu)
    const action = item.action
    if (action) option.click = () => { void runPetMenuAction(action) }
    return option
  })
}

async function runPetMenuAction(action: PetMenuAction): Promise<void> {
  if (isForwardedPetMenuAction(action)) {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('overlay:menu-action', action)
    }
    return
  }
  switch (action.kind) {
    case 'set-click-through':
      await patchWindowBehavior({ petClickThrough: action.value })
      break
    case 'set-avoidance':
      await patchWindowBehavior({ petAvoidanceEnabled: action.value })
      break
    case 'set-collapsed':
      await patchWindowBehavior({ petCollapsed: action.value })
      break
  }
  rebuildTrayMenu()
}

function popUpPetContextMenu(state: PetMenuState | null): void {
  const mode = getCurrentPetMode()
  const anchor = mode === 'clickThrough' && petHandleWindow && !petHandleWindow.isDestroyed() && petHandleWindow.isVisible()
    ? petHandleWindow
    : overlayWindow
  if (!anchor || anchor.isDestroyed()) return
  const items = buildPetMenu(mode, getCachedWindowBehaviorConfig(), state)
  Menu.buildFromTemplate(toMenuTemplate(items)).popup({ window: anchor })
}

function requestOverlayContextMenu(): void {
  if (
    !overlayWindow ||
    overlayWindow.isDestroyed() ||
    overlayWindow.webContents.isLoading() ||
    overlayWindow.webContents.isCrashed()
  ) {
    popUpPetContextMenu(null)
    return
  }
  overlayWindow.webContents.send('overlay:context-menu-requested')
}

function createPetHandle(overlay: BrowserWindow): BrowserWindow {
  const handle = createPetHandleWindow(overlay, PRELOAD_PATH)
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    handle.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/handle/index.html`)
  } else {
    handle.loadURL(`${APP_ORIGIN}/handle/index.html`)
  }
  return handle
}

function createOverlayWindow(): BrowserWindow {
  const { x, y, width, height } = resolveOverlayStartupBounds()
  noteOverlayCreatedCollapsed(getCachedWindowBehaviorConfig().petCollapsed)

  markProgrammaticWindowPlacement('overlay')

  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH
    }
  })

  if (getCachedWindowBehaviorConfig().petCollapsed) {
    win.setShape([{ x: 0, y: 0, width: COLLAPSED_SIZE, height: COLLAPSED_SIZE }])
    notePetShapeApplied(win)
  }

  win.on('closed', () => {
    if (petHandleWindow && !petHandleWindow.isDestroyed()) petHandleWindow.destroy()
    petHandleWindow = null
    setPetHandleWindow(null)
    overlayWindow = null
    clearDragState('overlay')
  })

  win.on('moved', () => {
    recheckPetShapeScale(win)
    handleWindowMoved('overlay', win, mainWindow, overlayWindow)
  })

  win.on('move', () => {
    if (petHandleWindow && !petHandleWindow.isDestroyed() && petHandleWindow.isVisible()) syncPetHandleBounds(petHandleWindow, win)
  })

  win.on('resize', () => {
    recheckPetShapeScale(win)
    if (petHandleWindow && !petHandleWindow.isDestroyed() && petHandleWindow.isVisible()) syncPetHandleBounds(petHandleWindow, win)
  })

  win.on('system-context-menu', event => {
    event.preventDefault()
    requestOverlayContextMenu()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/overlay/index.html`)
  } else {
    win.loadURL(`${APP_ORIGIN}/overlay/index.html`)
  }

  return win
}

let mainWindow: BrowserWindow | null = null

const TITLEBAR_OVERLAY_COLOR = '#0f0f1400'
const TITLEBAR_OVERLAY_SYMBOL_COLOR = '#e8e8f0'
const TITLEBAR_OVERLAY_HEIGHT = 25

function resolveChatStartupBounds(): Bounds {
  const displays = screen.getAllDisplays()
  const targetDisplay = getEffectiveHomeDisplay(displays, 'chat')
  const stored = getPreferredBounds('chat', targetDisplay.id)
  const bounds = stored ? clampBoundsToWorkArea(stored, targetDisplay.workArea) : computeDefaultBoundsForDisplay(targetDisplay, displays, DEFAULT_WINDOW_SIZE.chat, 'chat')
  if (!stored) {
    setPreferredBounds('chat', targetDisplay.id, bounds)
  }
  return bounds
}

function createWindow(): BrowserWindow {
  const { x, y, width, height } = resolveChatStartupBounds()

  markProgrammaticWindowPlacement('chat')

  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: TITLEBAR_OVERLAY_COLOR,
      symbolColor: TITLEBAR_OVERLAY_SYMBOL_COLOR,
      height: TITLEBAR_OVERLAY_HEIGHT
    },
    maximizable: false,
    minWidth: 240,
    minHeight: 360,
    webPreferences: {
      preload: PRELOAD_PATH
    }
  })

  mainWindow = win
  chatFirstShown = false

  let firstShowDone = false
  handleChatReady = event => {
    if (event.sender === win.webContents) performFirstShow()
  }
  const firstShowTimer = setTimeout(() => performFirstShow(), CHAT_READY_TIMEOUT_MS)

  function disposeFirstShow(): void {
    clearTimeout(firstShowTimer)
    handleChatReady = null
  }

  function performFirstShow(): void {
    if (firstShowDone) return
    firstShowDone = true
    disposeFirstShow()
    chatFirstShown = true
    if (win.isDestroyed()) return
    if (shouldShowChatOnFirstReady(pendingShowChat, launchedByAutostart)) {
      pendingShowChat = false
      showChatWindow()
      return
    }
    evaluateDesktopPresence(mainWindow, overlayWindow)
  }

  win.on('restore', () => {
    evaluateDesktopPresence(mainWindow, overlayWindow)
  })

  win.on('closed', () => {
    disposeFirstShow()
    mainWindow = null
    clearDragState('chat')
  })

  win.on('moved', () => {
    handleWindowMoved('chat', win, mainWindow, overlayWindow)
  })

  win.on('resized', () => {
    handleWindowMoved('chat', win, mainWindow, overlayWindow)
  })

  win.on('close', event => {
    if (!isQuitting) {
      event.preventDefault()
      win.hide()
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadURL(`${APP_ORIGIN}/index.html`)
  }

  return win
}

ipcMain.on('overlay:activate', () => requestShowChat())

ipcMain.on('overlay:edge-hover', (_event, hovered: unknown) => {
  requestOverlayEdgeHover(overlayWindow, hovered === true)
})

ipcMain.on('overlay:context-menu', (event, payload: unknown) => {
  if (!overlayWindow || overlayWindow.isDestroyed() || event.sender !== overlayWindow.webContents) return
  const state = payload == null ? null : parsePetMenuState(payload)
  if (payload != null && state === null) {
    console.warn('[PetMenu] invalid menu state from overlay renderer')
  }
  popUpPetContextMenu(state)
})

ipcMain.on('overlay:start-drag', event => {
  if (!overlayWindow || overlayWindow.isDestroyed() || event.sender !== overlayWindow.webContents) return
  if (getCurrentPetMode() !== 'normal') return
  startNativeWindowDrag(overlayWindow)
})

ipcMain.on('pet-handle:context-menu', event => {
  if (!petHandleWindow || petHandleWindow.isDestroyed() || event.sender !== petHandleWindow.webContents) return
  requestOverlayContextMenu()
})

ipcMain.on('overlay:presence-ready', () => {
  sendCurrentPetPresenceOnReady(overlayWindow)
})

ipcMain.on('overlay:set-size', (event, size: { baseWidth?: unknown; baseHeight?: unknown; scale?: unknown }) => {
  if (!overlayWindow || event.sender !== overlayWindow.webContents) return
  if (!Number.isFinite(size?.baseWidth) || !Number.isFinite(size?.baseHeight)) return
  if (!(PET_SCALE_OPTIONS as readonly unknown[]).includes(size.scale)) return
  const baseWidth = Math.round(size.baseWidth as number)
  const baseHeight = Math.round(size.baseHeight as number)
  if (baseWidth < 1 || baseHeight < 1) return
  applyOverlaySize(overlayWindow, { baseWidth, baseHeight, scale: size.scale as number })
})

ipcMain.on('titlebar:set-overlay', (_event, overlay: { color?: unknown; symbolColor?: unknown }) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (typeof overlay?.color !== 'string' || typeof overlay?.symbolColor !== 'string') return
  try {
    mainWindow.setTitleBarOverlay({ color: overlay.color, symbolColor: overlay.symbolColor })
  } catch (err) {
    console.error('[Titlebar] Failed to apply overlay:', err)
  }
})

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return

  protocol.handle('app', async (request) => {
    const file = resolveAppAssetPath(RENDERER_ROOT, request.url)
    if (!file) return new Response('Not Found', { status: 404 })
    try {
      return await net.fetch(pathToFileURL(file).toString())
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })

  app.on('browser-window-created', (_event, win) => {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.control || input.meta) && input.shift && input.code === 'KeyI') {
        event.preventDefault()
        win.webContents.openDevTools()
      }
    })
    win.webContents.on('console-message', (details) => {
      if (details.level !== 'warning' && details.level !== 'error') return
      const source = windowNameFromUrl(win.webContents.getURL())
      appendLogLine({ level: details.level === 'error' ? 'error' : 'warn', source, text: details.message })
    })
  })

  migrateLegacyAutostart()

  if (!isDevMode) await ensureCoreRunning(CORE_URL, app.getAppPath())

  if (shouldDistrustHomeAtStartup(queryUserNotificationState())) {
    closeStartupGate()
    setTimeout(() => {
      openStartupGate()
      evaluateDesktopPresence(mainWindow, overlayWindow)
    }, STARTUP_GATE_TIMEOUT_MS)
  }

  Menu.setApplicationMenu(null)
  const chatWindow = createWindow()
  overlayWindow = createOverlayWindow()
  startPetTopmostGuard(() => overlayWindow)
  armPetSizeGate(overlayWindow)
  petHandleWindow = createPetHandle(overlayWindow)
  setPetHandleWindow(petHandleWindow)
  startWindowDragMonitor(
    overlayWindow,
    () => {
      noteDragStart('overlay')
      cancelProgrammaticMoveOnDragStart('overlay')
      overlayWindow?.webContents.send('overlay:drag-start')
    },
    () => {
      noteDragEnd('overlay')
      overlayWindow?.webContents.send('overlay:drag-end')
    }
  )
  startWindowDragMonitor(
    chatWindow,
    () => {
      noteDragStart('chat')
      cancelProgrammaticMoveOnDragStart('chat')
    },
    () => noteDragEnd('chat')
  )
  applyUiLanguage('system')
  createTray()

  applyIconFromCurrentPreset()
  initWindowBehaviorConfig(mainWindow, overlayWindow)
  void refreshUiLanguage()
  subscribeToCoreEvents()

  powerMonitor.on('lock-screen', () => {
    notifySystemEvent('lock-screen')
    stopActiveWindowMonitoring()
    clearDragState('overlay')
    clearDragState('chat')
  })
  powerMonitor.on('unlock-screen', () => {
    notifySystemEvent('unlock-screen')
    startActiveWindowMonitoring()
    clearDragState('overlay')
    clearDragState('chat')
  })

  screen.on('display-added', handleDisplayTopologyChange)
  screen.on('display-removed', handleDisplayTopologyChange)
  screen.on('display-metrics-changed', handleDisplayTopologyChange)

  startActiveWindowMonitoring()

  evaluateDesktopPresence(mainWindow, overlayWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const reopenedChatWindow = createWindow()
      startWindowDragMonitor(
        reopenedChatWindow,
        () => {
          noteDragStart('chat')
          cancelProgrammaticMoveOnDragStart('chat')
        },
        () => noteDragEnd('chat')
      )
    }
  })
})

app.on('will-quit', () => {
  stopSpawnedCore()
  stopActiveWindowMonitoring()
  stopPetTopmostGuard()
  screen.removeListener('display-added', handleDisplayTopologyChange)
  screen.removeListener('display-removed', handleDisplayTopologyChange)
  screen.removeListener('display-metrics-changed', handleDisplayTopologyChange)
  isShuttingDownCoreEventsLoop = true
  if (coreEventsReconnectTimer) {
    clearTimeout(coreEventsReconnectTimer)
    coreEventsReconnectTimer = null
  }
})

app.on('quit', () => {
  stopSpawnedCore()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})