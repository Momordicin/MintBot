import { app, BrowserWindow, Menu, Tray, globalShortcut, powerMonitor, ipcMain, dialog, screen, nativeImage } from 'electron'
import { join, basename } from 'path'
import { readFile, stat } from 'fs/promises'
import { is } from '@electron-toolkit/utils'
import { startActiveWindowMonitor } from './activeWindowMonitor'
import { initWindowBehaviorConfig, updateCachedWindowBehaviorConfig, handleActiveWindowChange } from './windowBehavior'

// startActiveWindowMonitor 返回的清理函数（clearInterval）——挂到 will-quit，避免这个
// 500ms 轮询器的生命周期问题被"反正 app.quit() 会强杀进程"这个事实悄悄掩盖
let stopActiveWindowMonitor: (() => void) | null = null

// 核心服务地址：与渲染层 ChatWindow.tsx 的 CORE_URL 各自独立定义（两边本来就是独立代码，
// 不共享 shared/types，这里沿用既有约定）
const CORE_URL = 'http://127.0.0.1:3000'

// 悬浮窗行为策略配置的主进程本地类型：跟 CORE_URL 同样的独立定义约定，不反向导入
// services/core/config/index.ts（主进程只通过 HTTP 与核心服务交互，见 notifySystemEvent）。
// 这里的类型只服务于托盘菜单骨架本身（知道当前 pinMode 用于勾选态）；真正的置顶/躲避逻辑
// 在 electron/main/windowBehavior.ts 里（该文件按同样的独立定义约定维护自己的一份副本，
// 两者不互相 import）
type PinMode = 'off' | 'dodge-fullscreen' | 'always-on-top'

interface WindowBehaviorConfig {
  pinMode: PinMode
  fullscreenWhitelist: string[]
  blacklist: string[]
}

let tray: Tray | null = null
// 区分"用户点了托盘退出"与"用户点了聊天窗口的关闭按钮"——后者现在只隐藏窗口、触发悬浮窗，
// 不应该真的销毁窗口/退出应用
let isQuitting = false

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
    tray?.setImage(image)
  } catch (err) {
    console.error('[Icon] Failed to apply icon from current preset:', err)
  }
}

// 主进程第一次反过来订阅核心服务的 SSE 广播（GET /events，TDD §3.3）——此前主进程只会
// 单向调用核心服务（见上方 notifySystemEvent）。收到 preset-switched 帧后重新解析头像并
// 换图标；收到 window-behavior-changed 帧（子任务③新增）后更新 windowBehavior.ts 的内存
// 缓存并刷新托盘菜单勾选态。两个事件类型共用同一个 frame reader（buffer/'\n\n' 拆帧循环
// 只写一份），不为 window-behavior-changed 再单独开一个 /events 连接。断线不做自动重连：
// 这是锦上添花的功能，恢复只需重启应用，不值得为它引入重试逻辑
async function subscribeToCoreEvents(): Promise<void> {
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
        const lines = frame.split('\n')
        if (lines.some(line => line === 'event: preset-switched')) {
          applyIconFromCurrentPreset()
        }
        if (lines.some(line => line === 'event: window-behavior-changed')) {
          const dataLine = lines.find(line => line.startsWith('data: '))
          if (dataLine) {
            try {
              updateCachedWindowBehaviorConfig(JSON.parse(dataLine.slice('data: '.length)), mainWindow)
              rebuildTrayMenu()
            } catch (err) {
              console.error('[WindowBehavior] Failed to parse window-behavior-changed event:', err)
            }
          }
        }
        frameEnd = buffer.indexOf('\n\n')
      }
    }
  } catch (err) {
    console.error('[Events] core event subscription ended:', err)
  }
}

// 读当前悬浮窗行为策略配置，只用于构建托盘菜单的勾选态——失败时按 pinMode: 'off' 兜底，
// 跟 notifySystemEvent/applyIconFromCurrentPreset 一样的降级风格，不影响主进程本身
async function fetchWindowBehaviorConfig(): Promise<WindowBehaviorConfig | null> {
  try {
    const response = await fetch(`${CORE_URL}/config/window-behavior`)
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

async function patchPinMode(pinMode: PinMode): Promise<void> {
  try {
    await fetch(`${CORE_URL}/config/window-behavior`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinMode }),
    })
  } catch (err) {
    console.error('[Tray] Failed to patch pinMode:', err)
  }
}

// 重建托盘右键菜单：点击菜单项时改配置、菜单勾选态跟着变；外部配置变化（设置页 PATCH
// 或另一次托盘点击广播的 SSE window-behavior-changed）也会重新调这个函数刷新勾选态，
// 见 subscribeToCoreEvents 里的 window-behavior-changed 分支
async function rebuildTrayMenu(): Promise<void> {
  if (!tray) return
  const config = await fetchWindowBehaviorConfig()
  const currentPinMode: PinMode = config?.pinMode ?? 'off'

  const menu = Menu.buildFromTemplate([
    {
      label: '置顶',
      submenu: [
        {
          label: '关闭',
          type: 'radio',
          checked: currentPinMode === 'off',
          click: () => handlePinModeClick('off'),
        },
        {
          label: '全屏时跳非全屏屏幕置顶',
          type: 'radio',
          checked: currentPinMode === 'dodge-fullscreen',
          click: () => handlePinModeClick('dodge-fullscreen'),
        },
        {
          label: '绝对置顶',
          type: 'radio',
          checked: currentPinMode === 'always-on-top',
          click: () => handlePinModeClick('always-on-top'),
        },
      ],
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

async function handlePinModeClick(pinMode: PinMode): Promise<void> {
  await patchPinMode(pinMode)
  await rebuildTrayMenu()
}

// 图标先用空图占位，实际图标在 applyIconFromCurrentPreset() 里跟聊天窗口/悬浮窗一起
// setImage（见上方该函数末尾），这里不重复计算一份
function createTray(): void {
  tray = new Tray(nativeImage.createEmpty())
  rebuildTrayMenu()
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

// 悬浮窗行为策略的白名单/黑名单选 exe 文件：同上两个 select-*-file 的分工，主进程只负责
// 系统文件选择框；但这里只需要文件名做匹配（不像壁纸/角色卡要把文件内容传回渲染层），
// 不读文件字节，跳过 stat 大小校验/readFile
ipcMain.handle('select-exe-file', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Executable', extensions: ['exe'] }]
  })
  if (result.canceled || result.filePaths.length === 0) return null

  return { filename: basename(result.filePaths[0]) }
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

// 聊天窗口标题栏 chrome 常量（TDD §3.7 附「聊天栏 chrome 模型」，批次一）。颜色硬编码，
// 不接 displayConfig 动态下发——那是批次二的事。
//
// color 改为完全透明（alpha = 00）：此前 alpha 0.40 的原生底色与 .chat-titlebar 自绘的
// rgba(15,15,20,0.40) + backdrop-filter 各自独立绘制、互不叠加（.chat-titlebar 当时用
// width 收窄到按钮条带以外，见 src/chat/chat.css 里的历史注释），代价是按钮条带底下
// 没有毛玻璃、能看出一条「毛玻璃 vs 清晰」的接缝。现在反过来：原生层透明、不贡献任何
// 底色，.chat-titlebar 改回满宽，让它的背景与 backdrop-filter 铺满整条标题栏（包括
// 按钮条带底下），按钮符号直接画在自绘的毛玻璃上，接缝消失，也不再需要两层 alpha 保持
// 一致。RGB 分量在 alpha=0 时不可见，仍写 0f0f14 只是留个可读的锚点、便于日后再调 alpha
// 时有个对照值——它没有任何防御作用：真要是 alpha=0 被当成"未设置"，Electron 回落的是
// 它自己的系统默认色，根本不会来读这里的 RGB 分量。
//
// 已知风险，待实机验证（不在本次改动范围内解决）：
// 1) alpha=0 是否被 Electron/Chromium 视为合法值而非"未设置"进而回落系统默认色——
//    electron#38693（2023 合入）修的是"非完全不透明颜色被强制渲染成不透明"，针对的是
//    0 < alpha < 255 的情形，没有直接证据覆盖 alpha = 0 这个边界值，需实机确认按钮条带
//    确实变透明而非变回系统默认色。
// 2) hover/按下态是否仍可见——原生按钮的 hover 高亮是独立于 color 的绘制层，
//    electron#38431、electron#48193 记录过这块的渲染缺陷，是本次改动风险最高的一点，
//    必须目视确认交互态可感知。
const TITLEBAR_OVERLAY_COLOR = '#0f0f1400'
const TITLEBAR_OVERLAY_SYMBOL_COLOR = '#e8e8f0'
// 只能加高，不能压矮：Electron 的 WinFrameView::TitlebarHeight() 里是
// `if (custom_height > TitlebarMaximizedVisualHeight())`，阈值是运行时的
// `GetSystemMetricsInDIP(SM_CYCAPTION)`，随机器 DPI/文字缩放变化。本机实测 16 DIP，
// 故 25 有效；在系统标题栏为 32 DIP 的机器上 25 会被静默忽略，且因为
// `env(titlebar-area-height)` 走的是不过阈值的另一条路径，会出现「自绘区 25px、
// 按钮条带 32px」的台阶。该值必须与 src/chat/chat.css 里 .chat-titlebar 的 height 一致。
// 即便过了 DIP 阈值，生效值实际是 `custom_height - WindowTopY()`（非最大化时 WindowTopY()
// 通常是 1-2px 上边框偏移），而 `env(titlebar-area-height)` 返回的是未减去该偏移的原始值，
// 所以原生条带可能比 CSS 高度矮 1-2px，需目视确认是否可察觉
const TITLEBAR_OVERLAY_HEIGHT = 25

function createWindow() {
  const win = new BrowserWindow({
    width: 390,
    height: 700,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: TITLEBAR_OVERLAY_COLOR,
      symbolColor: TITLEBAR_OVERLAY_SYMBOL_COLOR,
      height: TITLEBAR_OVERLAY_HEIGHT
    },
    maximizable: false,
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

  // 关闭按钮不再销毁窗口：跟托盘"退出"区分开（isQuitting），聊天窗口关闭跟最小化一样
  // 只是隐藏 + 触发悬浮窗显示，应用继续在托盘常驻。用 close（可 preventDefault）而非
  // closed（已销毁后触发，拦不住）
  win.on('close', event => {
    if (!isQuitting) {
      event.preventDefault()
      win.hide()
      overlayWindow?.showInactive()
    }
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
  // 悬浮窗跟随聊天窗口的最小化/焦点/关闭状态显隐（见上方 createWindow 内的
  // minimize/focus/close 监听）
  overlayWindow = createOverlayWindow()
  // 托盘骨架先于 applyIconFromCurrentPreset 创建，保证该函数末尾的 tray?.setImage 生效时
  // tray 已存在（createTray 内部第一行同步执行 new Tray(...)，之后才有异步的菜单构建）
  createTray()

  // 两个窗口都创建完之后设置启动时的初始图标，拉取一次悬浮窗行为策略配置，并订阅之后的
  // preset 切换 / window-behavior-changed 事件（fire-and-forget，不阻塞启动；三者内部都已
  // try/catch，失败只 console.error）
  applyIconFromCurrentPreset()
  initWindowBehaviorConfig()
  subscribeToCoreEvents()

  globalShortcut.register('CommandOrControl+Shift+I', () => {
    BrowserWindow.getFocusedWindow()?.webContents.openDevTools()
  })

  powerMonitor.on('lock-screen', () => notifySystemEvent('lock-screen'))
  powerMonitor.on('unlock-screen', () => notifySystemEvent('unlock-screen'))

  // 真正的跳屏/隐藏/置顶/白名单黑名单逻辑见 electron/main/windowBehavior.ts
  // （buzzing-frolicking-eich.md 计划子任务③）。mainWindow/overlayWindow 在闭包里按引用
  // 读取，每次 tick 拿到的都是调用时刻的当前值，不会因为窗口重建/置空而脱节
  stopActiveWindowMonitor = startActiveWindowMonitor(info => handleActiveWindowChange(info, mainWindow, overlayWindow))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopActiveWindowMonitor?.()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})