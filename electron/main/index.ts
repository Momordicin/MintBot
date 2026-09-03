import { app, BrowserWindow, Menu, globalShortcut, powerMonitor, ipcMain, dialog, screen } from 'electron'
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

// 角色卡是纯文本 JSON 或轻量 PNG（不含 gif/大图立绘），几 MB 绰绰有余，不需要跟壁纸
// 共用同一个上限常量——两者体积量级本就不同，各自独立维护更直接
const CHARACTER_CARD_MAX_BYTES = 5 * 1024 * 1024

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

// 角色卡本地选文件：同上 select-wallpaper-file 的分工，主进程只负责系统文件选择框 +
// 读取文件字节，不做格式识别/字段映射（那是 services/core/characters/cardImport.ts 的职责）
ipcMain.handle('select-character-card-file', async () => {
  const result = await dialog.showOpenDialog({
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

let overlayWindow: BrowserWindow | null = null

// 悬浮窗尺寸/位置是这轮实现默认值，不是 TDD 已经写死的架构决定（写死的只有下面
// alwaysOnTop/transparent/frame 三项，见 docs/MintBot_TDD.md §3.7「悬浮窗技术要点」）
const OVERLAY_WIDTH = 220
const OVERLAY_HEIGHT = 220

function createOverlayWindow(): BrowserWindow {
  // 用 workArea（带 x/y 偏移）而不是 workAreaSize（只有宽高）：任务栏停靠在上边/左边时
  // workArea.x/y 不为 0，只用宽高算出来的坐标会跟任务栏厚度错位，没有真正贴住右下角
  const { x: workAreaX, y: workAreaY, width: workAreaWidth, height: workAreaHeight } = screen.getPrimaryDisplay().workArea

  const win = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    x: workAreaX + workAreaWidth - OVERLAY_WIDTH,
    y: workAreaY + workAreaHeight - OVERLAY_HEIGHT,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    // 悬浮窗这轮纯展示（不接收键盘输入，也没有可交互内容），不该在启动时抢主聊天窗口的焦点。
    // 两个窗口的加载都是异步的，谁先 ready-to-show 没有先后保证——如果跟聊天窗口一样用
    // show()，悬浮窗有真实概率在聊天窗口拿到焦点之后才显示完成，从而把焦点偷走
    focusable: false,
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => {
    win.showInactive()
  })

  win.on('closed', () => {
    overlayWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/overlay/index.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/overlay/index.html'))
  }

  return win
}

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
  // 这轮悬浮窗跟聊天窗口一起在应用启动时显示，不接聊天窗口最小化/焦点/关闭的生命周期
  // 联动（那是明确延后的后续工作，见 buzzing-frolicking-eich.md 计划）
  overlayWindow = createOverlayWindow()

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