import { app, BrowserWindow, Menu, globalShortcut, powerMonitor, ipcMain, dialog, screen, nativeImage } from 'electron'
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

// 应用图标跟随当前 preset 头像（聊天窗口 + 悬浮窗）：读 GET /state 拿当前 characterId，
// 再读该角色的 manifest.json 拿 avatar 相对路径，拼出静态资源 URL（/characters/ 前缀
// 挂载见 services/core/index.ts）。返回 null 表示当前没有可用头像（无活跃 session/
// manifest 里没有 avatar），调用方据此跳过换图标
async function resolveCurrentAvatarUrl(): Promise<string | null> {
  const stateResponse = await fetch(`${CORE_URL}/state`)
  const state = await stateResponse.json()
  const characterId = state?.presetSnapshot?.characterId
  if (!characterId) return null

  const manifestResponse = await fetch(`${CORE_URL}/characters/${encodeURIComponent(characterId)}/manifest.json`)
  const manifest = await manifestResponse.json()
  const avatar = manifest?.avatar
  if (!avatar) return null

  // 按段 encodeURIComponent 再用 '/' 拼接，不对整段相对路径一次性 encodeURIComponent
  // （那样会把分隔符 '/' 也编码掉）——跟 src/overlay/OverlayApp.tsx 的 resolveAssetUrl
  // 同一处理方式，主进程没法直接 import renderer 代码，这里体量太小不值得抽共享模块
  const encodedAvatarPath = avatar.split('/').map(encodeURIComponent).join('/')
  return `${CORE_URL}/characters/${encodeURIComponent(characterId)}/${encodedAvatarPath}`
}

// 失败只 console.error，不抛错、不影响应用启动/运行——跟 notifySystemEvent 一样的
// 降级风格，图标同步是锦上添花的功能，不该拖垮主进程
//
// 代次计数器：连续快速切换 preset 时，两次调用各自的异步链（/state → manifest.json →
// 头像字节）耗时不同，可能后发出的调用先解析完、先发出的调用反而后解析完，导致图标
// 定格在不是"当前实际 preset"的头像上——跟 src/overlay/OverlayApp.tsx 的 loadGenRef
// 同一套模式：只有最新一次调用捕获的代次仍然匹配时才真正落地 setIcon
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
  } catch (err) {
    console.error('[Icon] Failed to apply icon from current preset:', err)
  }
}

// 主进程第一次反过来订阅核心服务的 SSE 广播（GET /events，TDD §3.3）——此前主进程只会
// 单向调用核心服务（见上方 notifySystemEvent）。收到 preset-switched 帧后重新解析头像并
// 换图标。断线不做自动重连：这是锦上添花的功能，恢复只需重启应用，不值得为它引入重试逻辑
async function subscribeToPresetSwitchEvents(): Promise<void> {
  try {
    const response = await fetch(`${CORE_URL}/events`)
    const reader = response.body?.getReader()
    if (!reader) return

    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let frameEnd = buffer.indexOf('\n\n')
      while (frameEnd !== -1) {
        const frame = buffer.slice(0, frameEnd)
        buffer = buffer.slice(frameEnd + 2)
        // 按行精确匹配 event 字段，不用整帧 substring 搜索——避免未来事件名共享前缀
        // （如假设的 preset-switched-ack）或 data 载荷文本恰好包含这段字符串时误判
        if (frame.split('\n').some(line => line === 'event: preset-switched')) {
          applyIconFromCurrentPreset()
        }
        frameEnd = buffer.indexOf('\n\n')
      }
    }
  } catch (err) {
    console.error('[Icon] preset-switched subscription ended:', err)
  }
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
    // 两个窗口的加载都是异步的，谁先 ready-to-show 没有先后保证——如果聊天窗口已经先一步
    // 拿到焦点（它自己的 focus 监听已经把悬浮窗隐藏过一次，但那次悬浮窗还没显示，等于白隐藏），
    // 这里再无条件 showInactive() 会让悬浮窗显示出来之后再也没有下一次 focus 事件去收起它，
    // 一直卡在"启动后应该隐藏却显示着"的状态，直到用户手动切走再切回聊天窗口
    if (!mainWindow?.isFocused()) {
      win.showInactive()
    }
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

let mainWindow: BrowserWindow | null = null

function createWindow() {
  const win = new BrowserWindow({
    width: 390,
    height: 700,
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      sandbox: false
    }
  })

  mainWindow = win

  win.on('ready-to-show', () => {
    win.show()
  })

  win.on('closed', () => {
    mainWindow = null
  })

  win.on('minimize', () => {
    overlayWindow?.showInactive()
  })

  win.on('focus', () => {
    overlayWindow?.hide()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 悬浮窗侧点击恢复聊天窗口：单向通知，不需要返回值，用 ipcMain.on 而非 handle
ipcMain.on('overlay:activate', () => {
  mainWindow?.show()
  mainWindow?.focus()
  overlayWindow?.hide()
})

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  createWindow()
  // 悬浮窗跟随聊天窗口的最小化/焦点状态显隐（见上方 createWindow 内的 minimize/focus
  // 监听）；关闭时启动悬浮窗留到系统托盘做完之后再接，见 buzzing-frolicking-eich.md 计划
  overlayWindow = createOverlayWindow()

  // 两个窗口都创建完之后设置启动时的初始图标，并订阅之后的 preset 切换事件（fire-and-forget，
  // 不阻塞启动；两者内部都已 try/catch，失败只 console.error）
  applyIconFromCurrentPreset()
  subscribeToPresetSwitchEvents()

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