import { app, BrowserWindow, Menu, globalShortcut, powerMonitor, ipcMain, dialog } from 'electron'
import { join, basename } from 'path'
import { readFile, stat } from 'fs/promises'
import { is } from '@electron-toolkit/utils'

// 核心服务地址：与渲染层 ChatWindow.tsx 的 CORE_URL 各自独立定义（两边本来就是独立代码，
// 不共享 shared/types，这里沿用既有约定）
const CORE_URL = 'http://127.0.0.1:3000'

// 主进程只转发原始系统信号，不做任何判断/计时逻辑（那些都在核心服务侧，TDD §3.2
// "主进程检测到系统事件后通过本地 HTTP 调用核心服务内部管理接口"）。核心服务尚未启动/
// 暂时不可用时尽力而为，不重试、不报错，不能让这个通知影响主进程本身
function notifySystemEvent(type: 'lock-screen' | 'unlock-screen'): void {
  fetch(`${CORE_URL}/internal/system-event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type }),
  }).catch(() => {})
}

// 与 services/core/routes/presets.ts 的 bodyLimit 保持一致：超过这个大小的文件注定会被
// 服务端拒绝，在读入内存、经 IPC 结构化克隆之前就提前拦掉，省掉一次必然失败的传输
const WALLPAPER_MAX_BYTES = 10 * 1024 * 1024

// 两个窗口共用同一份 preload（设置窗口不单独写一份），提成常量避免两处字面量各自维护、
// 未来其中一处改动时悄悄失去同步
const PRELOAD_PATH = join(__dirname, '../preload/index.mjs')

// 壁纸本地选图：主进程只负责调起系统文件选择框、读取文件字节并转发给渲染层，
// 不做扩展名校验/存储路径决策（那些是核心服务的业务逻辑，见 docs/MintBot_TDD.md 壁纸存储约定）
ipcMain.handle('select-wallpaper-file', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
  })
  if (result.canceled || result.filePaths.length === 0) return null

  const filePath = result.filePaths[0]
  const { size } = await stat(filePath)
  if (size > WALLPAPER_MAX_BYTES) {
    // null 已经被用来表示"用户取消选择"（非失败），这里是真的失败场景，
    // 用 invoke() 的 reject 通道传递，交给渲染层已有的 try/catch 处理
    throw new Error('file-too-large')
  }

  const buffer = await readFile(filePath)
  // Buffer 经 IPC 结构化克隆时可能无法正确还原，显式转成 Uint8Array 传递
  return { data: new Uint8Array(buffer), filename: basename(filePath) }
})

let settingsWindow: BrowserWindow | null = null

function createSettingsWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 760,
    height: 560,
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      sandbox: false
    }
  })

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

// 记忆管理数据随时间变化，重开窗口应该拉新数据，不做隐藏保留——已存在且未销毁时只 focus
ipcMain.handle('open-settings-window', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }
  settingsWindow = createSettingsWindow()
})

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  createWindow()

  globalShortcut.register('CommandOrControl+Shift+I', () => {
    BrowserWindow.getFocusedWindow()?.webContents.openDevTools()
  })

  powerMonitor.on('lock-screen', () => notifySystemEvent('lock-screen'))
  powerMonitor.on('unlock-screen', () => notifySystemEvent('unlock-screen'))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})