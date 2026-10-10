// electron/main/index.ts — Electron 主进程入口：app ready 后创建聊天窗口、桌宠 overlay 与托盘，注册 IPC，启动前台窗口监控与 core /events 订阅，will-quit 时收尾
// 用法：electron.vite.config.ts 的主进程 entry；第一条 import 为 logBootstrap；设置窗口按 open-settings-window IPC 按需创建
// 对应文件：electron/preload/index.ts（暴露的 IPC 通道）/ electron/main/windowBehavior.ts / electron/main/coreEventsConsumer.ts / electron/main/activeWindowMonitor.ts / electron/main/windowDragMonitor.ts / electron/main/startupGate.ts / shared/windowBehavior.ts
import './logBootstrap'
import { app, BrowserWindow, Menu, Tray, powerMonitor, ipcMain, dialog, screen, nativeImage } from 'electron'
import { join, basename } from 'path'
import { readFile, stat } from 'fs/promises'
import { is } from '@electron-toolkit/utils'
import { startActiveWindowMonitor } from './activeWindowMonitor'
import { startWindowDragMonitor } from './windowDragMonitor'
import { noteDragStart, noteDragEnd, clearDragState } from './dragActivity'
import { nextReconnectDelayMs, RECONNECT_BACKOFF_FLOOR_MS } from './reconnectBackoff'
import { EVENTS_CLIENT_TIMEOUT_MS } from './eventsGeneration'
import { createCoreEventsConsumer } from './coreEventsConsumer'
import { CORE_URL } from './coreUrl'
import { appendLogLine } from '../../shared/logFile.js'
import { windowNameFromUrl } from './logWindowName'
import type { ChatPinMode, WindowBehaviorConfig, WindowBehaviorSnapshot } from '../../shared/windowBehavior.js'
import {
  initWindowBehaviorConfig,
  applyWindowBehaviorSnapshot,
  getCachedWindowBehaviorConfig,
  evaluateDesktopPresence,
  handleWindowMoved,
  markProgrammaticWindowPlacement,
  closeStartupGate,
  openStartupGate,
  invalidateStaleAppliedDisplayIds,
  markTopologySettle,
  requestOverlayEdgeHover,
  sendCurrentPetPresenceOnReady,
  applyOverlaySize,
  cancelProgrammaticMoveOnDragStart
} from './windowBehavior'
import {
  queryUserNotificationState,
  shouldDistrustHomeAtStartup,
  STARTUP_GATE_TIMEOUT_MS
} from './startupGate'
import {
  updateDisplayStateMap,
  startBlockerValidationLoop,
  revalidateBlockersNow
} from './foregroundWorldModel'
import {
  getPreferredBounds,
  setPreferredBounds,
  getEffectiveHomeDisplay,
  clampBoundsToWorkArea,
  computeDefaultBoundsForDisplay,
  DEFAULT_WINDOW_SIZE
} from './windowPositions'
import type { Bounds } from './windowPositions'

let stopActiveWindowMonitor: (() => void) | null = null
let stopBlockerValidation: (() => void) | null = null

const handleDisplayTopologyChange = (): void => {
  markTopologySettle()
  revalidateBlockersNow()
  invalidateStaleAppliedDisplayIds()
  evaluateDesktopPresence(mainWindow, overlayWindow)
}

function startActiveWindowMonitoring(): void {
  if (stopActiveWindowMonitor) return
  stopActiveWindowMonitor = startActiveWindowMonitor(observation => {
    updateDisplayStateMap(observation)
    if (observation.kind === 'external') openStartupGate()
    evaluateDesktopPresence(mainWindow, overlayWindow)
  })
  stopBlockerValidation = startBlockerValidationLoop(() => evaluateDesktopPresence(mainWindow, overlayWindow))
}

function stopActiveWindowMonitoring(): void {
  stopActiveWindowMonitor?.()
  stopActiveWindowMonitor = null
  stopBlockerValidation?.()
  stopBlockerValidation = null
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

const coreEventsConsumer = createCoreEventsConsumer({
  converge,
  onPresetSwitched: applyIconFromCurrentPreset,
  onWindowBehaviorChanged: snapshot => {
    applyWindowBehaviorSnapshot(snapshot, mainWindow, overlayWindow)
    rebuildTrayMenu()
  },
  log: {
    generationChanged: () =>
      console.log('[Events] Core service generation changed — the core process restarted, this is not the same server process we were talking to before (diagnostic only, does not itself trigger a resync)'),
    helloHeartbeatParseError: err => console.error('[Events] Failed to parse hello/heartbeat event:', err),
    windowBehaviorParseError: err => console.error('[WindowBehavior] Failed to parse window-behavior-changed event:', err),
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
      console.error('[Tray] Core rejected window behavior patch:', response.status)
      return
    }
    applyWindowBehaviorSnapshot((await response.json()) as WindowBehaviorSnapshot, mainWindow, overlayWindow)
  } catch (err) {
    console.error('[Tray] Failed to patch window behavior config:', err)
  }
}

function rebuildTrayMenu(): void {
  if (!tray) return
  const { chatPinMode: currentChatPinMode, petAvoidanceEnabled } = getCachedWindowBehaviorConfig()

  const menu = Menu.buildFromTemplate([
    {
      label: '聊天窗口置顶',
      submenu: [
        {
          label: '始终',
          type: 'radio',
          checked: currentChatPinMode === 'always',
          click: () => handleChatPinModeClick('always'),
        },
        {
          label: '智能',
          type: 'radio',
          checked: currentChatPinMode === 'smart',
          click: () => handleChatPinModeClick('smart'),
        },
        {
          label: '关闭',
          type: 'radio',
          checked: currentChatPinMode === 'off',
          click: () => handleChatPinModeClick('off'),
        },
      ],
    },
    {
      label: '桌宠智能避让',
      type: 'checkbox',
      checked: petAvoidanceEnabled,
      click: () => handlePetAvoidanceClick(!petAvoidanceEnabled),
    },
    {
      label: '打开聊天窗口',
      click: () => {
        mainWindow?.show()
        mainWindow?.focus()
      },
    },
    {
      label: '退出',
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
  tray.on('double-click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
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
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
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
    filters: [{ name: 'Character Cards', extensions: ['json', 'png'] }]
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
    filters: [{ name: 'Executable', extensions: ['exe'] }]
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
    win.loadFile(join(__dirname, '../renderer/settings/index.html'))
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
  return bounds
}

function createOverlayWindow(): BrowserWindow {
  const { x, y, width, height } = resolveOverlayStartupBounds()

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

  win.on('closed', () => {
    overlayWindow = null
    clearDragState('overlay')
  })

  win.on('moved', () => {
    handleWindowMoved('overlay', win, mainWindow, overlayWindow)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/overlay/index.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/overlay/index.html'))
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
    webPreferences: {
      preload: PRELOAD_PATH
    }
  })

  mainWindow = win

  win.on('ready-to-show', () => {
    win.show()
  })

  win.on('closed', () => {
    mainWindow = null
    clearDragState('chat')
  })

  win.on('moved', () => {
    handleWindowMoved('chat', win, mainWindow, overlayWindow)
  })

  win.on('resize', () => {
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
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

ipcMain.on('overlay:activate', () => {
  mainWindow?.show()
  mainWindow?.focus()
})

ipcMain.on('overlay:edge-hover', (_event, hovered: unknown) => {
  requestOverlayEdgeHover(overlayWindow, hovered === true)
})

ipcMain.on('overlay:presence-ready', () => {
  sendCurrentPetPresenceOnReady(overlayWindow)
})

ipcMain.on('overlay:set-size', (event, size: { width?: unknown; height?: unknown }) => {
  if (!overlayWindow || event.sender !== overlayWindow.webContents) return
  if (!Number.isFinite(size?.width) || !Number.isFinite(size?.height)) return
  const width = Math.round(size.width as number)
  const height = Math.round(size.height as number)
  if (width < 1 || height < 1) return
  applyOverlaySize(overlayWindow, { width, height })
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

app.whenReady().then(() => {
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
  createTray()

  applyIconFromCurrentPreset()
  initWindowBehaviorConfig(mainWindow, overlayWindow)
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
  stopActiveWindowMonitoring()
  screen.removeListener('display-added', handleDisplayTopologyChange)
  screen.removeListener('display-removed', handleDisplayTopologyChange)
  screen.removeListener('display-metrics-changed', handleDisplayTopologyChange)
  isShuttingDownCoreEventsLoop = true
  if (coreEventsReconnectTimer) {
    clearTimeout(coreEventsReconnectTimer)
    coreEventsReconnectTimer = null
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})