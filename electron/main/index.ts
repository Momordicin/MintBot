import { app, BrowserWindow, Menu, Tray, globalShortcut, powerMonitor, ipcMain, dialog, screen, nativeImage } from 'electron'
import { join, basename } from 'path'
import { readFile, stat } from 'fs/promises'
import { is } from '@electron-toolkit/utils'
import { startActiveWindowMonitor } from './activeWindowMonitor'
import { startWindowDragMonitor } from './windowDragMonitor'
import { noteDragStart, noteDragEnd, clearDragState } from './dragActivity'
import { nextReconnectDelayMs, RECONNECT_BACKOFF_FLOOR_MS } from './reconnectBackoff'
import { EVENTS_CLIENT_TIMEOUT_MS } from './eventsGeneration'
import { createCoreEventsConsumer } from './coreEventsConsumer'
import {
  initWindowBehaviorConfig,
  updateCachedWindowBehaviorConfig,
  evaluateDesktopPresence,
  handleWindowMoved,
  markProgrammaticWindowPlacement,
  closeStartupGate,
  openStartupGate,
  invalidateStaleAppliedDisplayIds,
  markTopologySettle,
  requestOverlayEdgeHover,
  sendCurrentPetPresenceOnReady,
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
  computeSizeForDisplay,
  computeDefaultBoundsForDisplay,
  DEFAULT_WINDOW_SIZE
} from './windowPositions'
import type { Bounds } from './windowPositions'

// startActiveWindowMonitor 返回的清理函数（clearInterval）。非空即代表监听正在运行——
// 这个判断本身就是下方 startActiveWindowMonitoring/stopActiveWindowMonitoring 防重复
// 启动/防重复停止的依据，不另设一个布尔标志
let stopActiveWindowMonitor: (() => void) | null = null
// Stage 1 新增的低频校验循环（electron/main/foregroundWorldModel.ts）清理函数，跟上面
// stopActiveWindowMonitor 同一套幂等约定、同一套锁屏生命周期——两者配对启停，不单独暴露
// 给别的调用点
let stopBlockerValidation: (() => void) | null = null

// Finding D（Stage 1 review）：display-topology 监听器（screen.on('display-added' 等）是
// "两个循环、同一套生命周期"这条既有约定的一个刻意例外——见下方 app.whenReady() 里注册处的
// 注释与 docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"锁屏与解锁"一节那条 blockquote。
// 注册与注销都必须用同一个具名函数引用（screen.removeListener 依赖引用相等），因此提到
// 模块作用域，不能像别处一样用内联箭头函数注册后就不管。
//
// Stage 2：拓扑变化重新归属 blocker 之后，desired 状态可能已经变了（例如刚刚被拔掉的显示器
// 曾经是 Pet/Chat 的落点），紧跟着调一次 evaluateDesktopPresence 兜底，不等下一次前台
// 变化/1500ms 校验
//
// Fix C（second rework pass）：invalidateStaleAppliedDisplayIds 在 evaluateDesktopPresence 之前
// 显式调用一次，而不是指望 evaluatePetPresence/evaluateChatPresence 内部的 appliedDisplayIdFor
// 读取顺便发现并清掉——拔掉一块屏之后，OS 会自己重新摆放窗口并发一次原生 'moved'，跟 Electron
// 的 display-removed 分发之间没有顺序保证；若那次 'moved' 先到，纠正不能只靠"下一次 evaluate
// 恰好读到了 appliedDisplayId"，见 windowBehavior.ts invalidateStaleAppliedDisplayIds 定义处
// 注释
const handleDisplayTopologyChange = (): void => {
  // 必须排在最前：拔掉显示器时 Windows 会自己把窗口重新摆到别的屏并发原生 'moved'，该事件
  // 与用户拖拽无法区分。先开静默窗口，才能保证那个事件走不到 persistBoundsNow——见
  // windowBehavior.ts markTopologySettle 的注释
  markTopologySettle()
  revalidateBlockersNow()
  invalidateStaleAppliedDisplayIds()
  evaluateDesktopPresence(mainWindow, overlayWindow)
}

// 锁屏期间暂停 Win32 前台窗口轮询
// lock-screen 停止、unlock-screen 重新拉起
// stopActiveWindowMonitor非空代表运行中, 不会出现重复启动, 是幂等的
// 重启后 startActiveWindowMonitor 内部的 `previous` 是全新闭包（初值
// null），解锁后第一次 tick 因此会多触发一次 onChange——这是预期行为，不需要抑制
function startActiveWindowMonitoring(): void {
  if (stopActiveWindowMonitor) return
  // 每次观察先喂给世界模型（建立/刷新 DisplayStateMap），再无条件重新 evaluate 一次
  // 桌面呈现——resolver + diff 本身保证了 desired 状态不变时不产生任何 Electron 调用
  // （见 windowBehavior.ts evaluateDesktopPresence 头部注释），不需要在这里先判断"这次
  // 观察值不值得处理"。openStartupGate 只在这一 tick 确实是 external 观察时才可能真正
  // 打开门控（该函数本身是幂等的，门控已经开着时调用是 no-op）——self/unavailable 不满足
  // "首次 external 观测到达"这个开门条件，见 electron/main/startupGate.ts 头部注释
  stopActiveWindowMonitor = startActiveWindowMonitor(observation => {
    updateDisplayStateMap(observation)
    if (observation.kind === 'external') openStartupGate()
    evaluateDesktopPresence(mainWindow, overlayWindow)
  })
  // onValidated：每完成一轮 blocker 复查（含首次立即执行的那一轮）都重新 evaluate 一次——
  // 覆盖"blocker 消失但没有伴随新的前台观测"的情形（例如挡路的窗口被直接关闭），见
  // foregroundWorldModel.ts startBlockerValidationLoop 头注释
  stopBlockerValidation = startBlockerValidationLoop(() => evaluateDesktopPresence(mainWindow, overlayWindow))
}

function stopActiveWindowMonitoring(): void {
  stopActiveWindowMonitor?.()
  stopActiveWindowMonitor = null
  stopBlockerValidation?.()
  stopBlockerValidation = null
}

// 核心服务地址：与渲染层 ChatWindow.tsx 的 CORE_URL 各自独立定义
// 不共享 shared/types
const CORE_URL = 'http://127.0.0.1:3000'

// 悬浮窗行为策略配置的主进程本地类型：跟 CORE_URL 同样的独立定义约定，不反向导入
// services/core/config/index.ts（主进程只通过 HTTP 与核心服务交互，见 notifySystemEvent）。
// 这里的类型只服务于托盘菜单骨架本身（知道当前 chatPinMode/petAvoidanceEnabled 用于勾选态）；
// 真正的置顶/躲避逻辑在 electron/main/windowBehavior.ts 里（该文件按同样的独立定义约定维护
// 自己的一份副本，两者不互相 import）。
//
// Stage 4（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"配置模型拆分：pinMode 不再是全局概念
// （阶段④）"）：旧的三选一 pinMode 被拆成两个独立概念，见 windowBehavior.ts 同名类型定义处的
// 注释——这里只保留托盘菜单需要的字段形状，appRules 的具体规则内容托盘菜单不需要展示
type ChatPinMode = 'always' | 'smart' | 'off'

interface WindowBehaviorConfig {
  chatPinMode: ChatPinMode
  petAvoidanceEnabled: boolean
  appRules: Array<{ exeName: string; effect: 'allow' | 'soft' | 'hard' }>
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
    settingsWindow?.setIcon(image)
    tray?.setImage(image)
  } catch (err) {
    console.error('[Icon] Failed to apply icon from current preset:', err)
  }
}

// 帧解析/分发 + "连接建立时收敛恰好一次"的编排抽在 coreEventsConsumer.ts（不 import
// 'electron'，可单测；这里只注入真正依赖 Electron 运行时的副作用）。lastSeenCoreGeneration
// 这个跨重连持久化的诊断状态现在也收进那个模块内部，不再是本文件的模块级变量——见该文件
// 顶部注释「状态生命周期」。只创建这一个实例，贯穿整个 subscribeToCoreEvents 重连循环
// （不是每次连接尝试各建一个），换图标/刷新托盘菜单勾选态这些副作用都通过下面这几个既有
// 函数注入，不在 coreEventsConsumer.ts 里重新实现一遍
const coreEventsConsumer = createCoreEventsConsumer({
  converge,
  onPresetSwitched: applyIconFromCurrentPreset,
  onWindowBehaviorChanged: config => {
    updateCachedWindowBehaviorConfig(config, mainWindow, overlayWindow)
    rebuildTrayMenu()
  },
  log: {
    generationChanged: () =>
      console.log('[Events] Core service generation changed — the core process restarted, this is not the same server process we were talking to before (diagnostic only, does not itself trigger a resync)'),
    helloHeartbeatParseError: err => console.error('[Events] Failed to parse hello/heartbeat event:', err),
    windowBehaviorParseError: err => console.error('[WindowBehavior] Failed to parse window-behavior-changed event:', err),
  },
})

// 主进程第一次反过来订阅核心服务的 SSE 广播（GET /events，TDD §3.3）——此前主进程只会
// 单向调用核心服务（见上方 notifySystemEvent）。收到 preset-switched 帧后重新解析头像并
// 换图标；收到 window-behavior-changed 帧后更新 windowBehavior.ts 的内存缓存并刷新托盘
// 菜单勾选态；收到 hello/heartbeat 帧只做一件事——比较 generation 是否变化并打一行诊断
// 日志，不触发任何收敛（收敛已经在连接建立时无条件跑过，见下面 coreEventsConsumer.onConnected()
// 调用点）。四种事件类型共用同一个 frame reader（coreEventsConsumer.ts 内部的 buffer/'\n\n'
// 拆帧循环只写一份），不为其中任何一个再单独开一条 /events 连接。
//
// retry 循环见 subscribeToCoreEvents；单次连接尝试见 connectToCoreEvents
// generation 不再影响任何行为, 现在只保留作为诊断信号：记录"核心服务是否换过一个新进程"，仅用于打日志排障，
async function connectToCoreEvents(): Promise<boolean> {
  // 独立的 didConnect 变量保证只要真正连过，不论后续以哪种方式断开都会返回 true
  let didConnect = false

  // 存活看门狗：body 层面的超时，主动 abort交给外层 subscribeToCoreEvents 重连
  // 核心服务每 HEARTBEAT_INTERVAL_MS 广播一次心跳，第三次也没等到才真正判定连接已死

  // 没有用 undici 的 `dispatcher: new Agent({ bodyTimeout })` 
  // 已知缺口，本次改动不处理：
  // 需要一个独立于 body 看门狗的连接建立阶段超时
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

    // 每次连接建立（含每一次重连）都无条件收敛一次
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

// 幂等函数：
// 悬浮窗行为策略配置（GET /config/window-behavior，含随之而来的置顶态校正/跳屏 episode
// 收尾）、应用图标（间接读 GET /state）、托盘菜单勾选态（同样读 GET /config/window-behavior）。
// 经由 coreEventsConsumer.ts 的 onConnected() 在每次连接建立（含每一次重连）都无条件调用
// 一次——不挂在 hello/heartbeat 分支上、不依赖 generation 是否变化
//
// GET /state 是 session 维度的状态
// GET /config/window-behavior 是与 session 无关的全局应用配置，
// 两者语义不同、消费方也不同
// "一次权威读"在这里落地成一个函数入口，而不是把两个端点合并成一个请求
//
// initWindowBehaviorConfig 现在的实际触发频率等于"这条 SSE 连接
// 真正重连的次数"：加入心跳（HEARTBEAT_INTERVAL_MS）与客户端看门狗
// （EVENTS_CLIENT_TIMEOUT_MS）之后，意外掉线已经回落到接近"核心服务真的重启"的量级
function converge(): void {
  initWindowBehaviorConfig(mainWindow, overlayWindow)
  applyIconFromCurrentPreset()
  rebuildTrayMenu()
}

// will-quit 里置位，阻止退出过程中还在跑的 subscribeToCoreEvents 循环发起新一轮连接/
// 继续等待退避——没有这个标志，应用退出时循环仍会在 fetch 失败后排一个新的 setTimeout，
// 变成退出后还在后台重试的孤儿循环
let isShuttingDownCoreEventsLoop = false

// 当前待触发的退避定时器：will-quit 里 clearTimeout 掉，防止它在应用退出后继续持有
// 事件循环的引用/在退出后触发一次没有意义的重连。isShuttingDownCoreEventsLoop 与这个
// 定时器共同承担停止职责——前者防止「发起新一轮」，后者防止「已经在等待的这一轮还是触发了」
let coreEventsReconnectTimer: NodeJS.Timeout | null = null

function waitForCoreEventsReconnect(delayMs: number): Promise<void> {
  return new Promise(resolve => {
    coreEventsReconnectTimer = setTimeout(() => {
      coreEventsReconnectTimer = null
      resolve()
    }, delayMs)
  })
}

// 常驻共享广播流 长连接重连循环：无限重试
// 指数退避封顶在 RECONNECT_BACKOFF_CAP_MS（见 reconnectBackoff.ts）
// 只有真正连接成功过才把退避重置回下限 RECONNECT_BACKOFF_FLOOR_MS——tsx watch 保存触发的核心服务
// 重启正是这种「连过、又断开」的模式，退避重置保证这类重载几乎感觉不到断线；只有从未连上过
// （核心服务还没起来/整个不可达）才持续加倍退避，避免变成每次都立即重试的请求风暴
async function subscribeToCoreEvents(): Promise<void> {
  let delayMs = RECONNECT_BACKOFF_FLOOR_MS
  while (!isShuttingDownCoreEventsLoop) {
    const connected = await connectToCoreEvents()
    if (isShuttingDownCoreEventsLoop) return

    // 具体断开原因（fetch 失败/中途读取抛错）已经由 connectToCoreEvents 内部的
    // catch 打过一条日志，这里只打一条"接下来会怎么重试"的通用日志，不重复描述原因，
    // 也不会随退避轮次逐 tick 重复打（每次真正发起新一轮连接尝试前只打一次）
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

// 读当前悬浮窗行为策略配置，只用于构建托盘菜单的勾选态——失败时按 chatPinMode: 'off' /
// petAvoidanceEnabled: true 兜底（后者与 windowBehavior.ts DEFAULT_CONFIG 的默认值一致，
// 保持"配置取不到时维持现状行为"这条既有约定），跟 notifySystemEvent/
// applyIconFromCurrentPreset 一样的降级风格，不影响主进程本身
async function fetchWindowBehaviorConfig(): Promise<WindowBehaviorConfig | null> {
  try {
    const response = await fetch(`${CORE_URL}/config/window-behavior`)
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

async function patchWindowBehavior(partial: Partial<WindowBehaviorConfig>): Promise<void> {
  try {
    await fetch(`${CORE_URL}/config/window-behavior`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    })
  } catch (err) {
    console.error('[Tray] Failed to patch window behavior config:', err)
  }
}

// 重建托盘右键菜单：点击菜单项时改配置、菜单勾选态跟着变；外部配置变化（设置页 PATCH
// 或另一次托盘点击广播的 SSE window-behavior-changed）也会重新调这个函数刷新勾选态，
// 见 subscribeToCoreEvents 里的 window-behavior-changed 分支。
//
// Stage 4（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"配置模型拆分"一节，"托盘菜单"要求）：
// 拆成两个独立菜单项，不再是一个会被读成"全局置顶模式"的三选一——"聊天窗口置顶"只管聊天窗，
// "桌宠智能避让"是一个独立的勾选项，只管桌宠是否自动让路
async function rebuildTrayMenu(): Promise<void> {
  if (!tray) return
  const config = await fetchWindowBehaviorConfig()
  const currentChatPinMode: ChatPinMode = config?.chatPinMode ?? 'off'
  const petAvoidanceEnabled = config?.petAvoidanceEnabled ?? true

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
  await rebuildTrayMenu()
}

async function handlePetAvoidanceClick(petAvoidanceEnabled: boolean): Promise<void> {
  await patchWindowBehavior({ petAvoidanceEnabled })
  await rebuildTrayMenu()
}

// 图标先用空图占位，实际图标在 applyIconFromCurrentPreset() 里跟聊天窗口/悬浮窗一起
// setImage（见上方该函数末尾），这里不重复计算一份
function createTray(): void {
  tray = new Tray(nativeImage.createEmpty())
  // 双击托盘图标打开/恢复聊天窗口，跟右键菜单"打开聊天窗口"项完全同样的动作——.show() 对
  // 已最小化的窗口也会一并恢复，不需要额外判断
  tray.on('double-click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
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

// 问题3（buzzing-frolicking-eich.md）：把 win 定位到聊天窗口当前所在显示器的居中位置——
// mainWindow 为空/已销毁时退回主显示器。用 win 自己当前的宽高（不强改尺寸），只算居中坐标。
// createSettingsWindow() 与 open-settings-window 的复用分支共用这一个小函数，两条路径都
// 可能让设置窗口停留在聊天窗口所在屏幕之外的另一块显示器上（新建时从不指定位置；复用时
// 用户可能手动把它拖去了别的屏幕）
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

// parent: mainWindow
// 实测Electron 42.4.1 owned window 的三种父窗口状态迁移：
// ① 父窗口 minimize() → 子窗口自动隐藏（isVisible() 变 false），
// 父窗口 restore() 后子窗口自动恢复可见，不需要本文件任何代码介入；
// ② 父窗口 hide() → 子窗口不仍然可见；
// ③ 父窗口 应用退出路径正常 destroy()  → 子窗口跟着销毁
// ?? undefined 是类型层面的兜底
function createSettingsWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 760,
    height: 560,
    show: false,
    parent: mainWindow ?? undefined,
    webPreferences: {
      preload: PRELOAD_PATH,
      sandbox: false
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

// 记忆管理数据随时间变化，重开窗口应该拉新数据，不做隐藏保留——已存在且未销毁时先挪回
// 聊天窗口所在显示器再 focus：设置窗口若停留在聊天窗口所在屏幕之外的另一块显示器上，
// 只 focus() 只是把它带到最前面，但仍在用户视线之外的那块屏幕，看起来就像"点了没反应"
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
  // applyIconFromCurrentPreset() 只在启动、preset-switched广播、SSE 重连时调用
  applyIconFromCurrentPreset()
})

let overlayWindow: BrowserWindow | null = null

// 悬浮窗尺寸是这轮实现默认值，不是 TDD 已经写死的架构决定（写死的只有下面
// alwaysOnTop/transparent/frame 三项，见 docs/MintBot_TDD.md §3.7「悬浮窗技术要点」）。
// 实际数值（132×132）与聊天窗口的默认值（290×520）一起定义在 windowPositions.ts 的
// DEFAULT_WINDOW_SIZE 里——那边的密度换算规则（computeSizeForDisplay/
// computeDefaultBoundsForDisplay）也需要同一份数字，两处不再各自维护一份。
//
// 启动恢复现在信任表里存的宽高（不再像旧版本那样恒用固定常量覆盖）：这块屏第一次出现时，
// computeDefaultBoundsForDisplay 算出的就是"这块屏该有的悬浮窗尺寸"这个唯一答案，
// relocate/启动恢复都经过同一个函数，不会再出现"表里存的是临时值"这种需要不信任的情况
// （见该函数注释）。
//
// Stage 2：不再调用 setLastDisplayId/setPreferredDisplayId——preferredDisplayId 现在是
// 用户真正选择的 home（只由真实拖拽写入，见 windowBehavior.ts persistBoundsNow），
// resolveStartupDisplay 在这里查到 null（还没有任何偏好记录，或记录的显示器已经不存在）
// 时退回最大显示器，只是这一次启动的落点决定，不代表"以后就把这块屏当成家"，因此不写回。
// windowBehavior.ts 的 evaluatePetPresence 用同一个 resolveStartupDisplay 调用，保证跟这里
// 算出的落点一致，见该函数内注释
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

  // 构造窗口同样是一次程序放置，必须记进冷却期——否则窗口落到目标屏后 Windows 异步发来的
  // WM_DPICHANGED 尺寸校正会被 handleWindowMoved 当成用户手动调整写进偏好表（详见该函数）
  markProgrammaticWindowPlacement('overlay')

  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    // 透明无边框窗口在 Windows 上仍会由 DWM 沿窗口矩形画一圈投影（hasShadow 默认 true）。
    // 深色桌面上看不出来，浅色/白底桌面上就是一个明显的方框——而悬浮窗的可见形状应该只有
    // 立绘本身，窗口矩形不该被看见
    hasShadow: false,
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

  // Stage 2：不再在 ready-to-show 里硬编码一次 showInactive()——悬浮窗的初始可见性完全交给
  // windowBehavior.ts 的 evaluatePetPresence（resolver + diff）决定，跟它此后每一次的显隐
  // 判断走同一条路径，不再有"启动这一刻单独摆一次"的特例。这也是启动门控
  // （electron/main/startupGate.ts）能够生效的前提——如果这里仍然无条件显示一次，门控会被
  // 这个硬编码调用绕过。第一次真正的 evaluateDesktopPresence 调用见 app.whenReady() 末尾
  // 与 startBlockerValidationLoop 的 onValidated 回调（foregroundWorldModel.ts）

  win.on('closed', () => {
    overlayWindow = null
    // Fix 2（second rework pass）：窗口被销毁是 dragActivity.ts 有界恢复要覆盖的三条中断路径
    // 之一——若销毁发生在拖拽中途（WM_EXITSIZEMOVE 因此永远不会到达），不清理会让 'overlay'
    // 的拖拽状态卡在 isDragging = true 直到 MAX_DRAG_DURATION_MS 上限自愈，这里直接精确清掉
    clearDragState('overlay')
  })

  // 问题1（buzzing-frolicking-eich.md）：用户真实拖动悬浮窗时，把拖动后的位置写回持久化
  // 偏好表（见 windowBehavior.ts handleWindowMoved 的判定逻辑）。悬浮窗当前 resizable:
  // false 且没有暴露拖动交互，这个监听器目前"装着但触发不到"，以后支持拖动直接生效
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

// 聊天窗口默认尺寸（此前是硬编码 390×700，从不查表，每次启动都会重置——现在改为
// 启动时查表恢复）实际数值定义在 windowPositions.ts 的 DEFAULT_WINDOW_SIZE.chat 里，
// 只在"该显示器第一次出现、表里还没有偏好记录"时才会被 computeSizeForDisplay 用到，
// 见 resolveChatStartupBounds

// 首次在某块显示器上打开聊天窗口时的默认位置：居中于该显示器的 workArea——用 workArea
// 而不是 workAreaSize，理由跟 windowPositions.ts 里 computeDefaultBoundsForDisplay
// 同一条注释：任务栏停靠在上边/左边时 workArea.x/y 不为 0，只用宽高算会跟任务栏厚度错位。
// 宽高走 computeSizeForDisplay（跟悬浮窗、跳屏/归位共用同一个密度换算规则），只有"贴
// workArea 右下角"换成"居中"这一点位置公式是聊天窗口自己的约定，两者不合并
function computeDefaultChatBounds(display: Electron.Display, displays: Electron.Display[]): Bounds {
  const { width, height } = computeSizeForDisplay(display, displays, DEFAULT_WINDOW_SIZE.chat)
  const { x: workAreaX, y: workAreaY, width: workAreaWidth, height: workAreaHeight } = display.workArea
  return {
    width,
    height,
    x: Math.round(workAreaX + (workAreaWidth - width) / 2),
    y: Math.round(workAreaY + (workAreaHeight - height) / 2),
  }
}

// 启动时的显示器/边界解析：① home（preferredDisplayId）仍连接着就用它，否则退回最大显示器
// （resolveStartupDisplay，见 windowPositions.ts 注释）；② 该显示器有偏好记录就查表夹紧
// 后使用，没有就居中算一次默认值并立刻存表——跟 windowBehavior.ts 里 relocate 首次落到某块
// 显示器时"查不到就算一次、立刻存表"的约定一致。
//
// Stage 2：不再调用 setLastDisplayId/setPreferredDisplayId 把这块显示器"记成最近一次使用"
// ——这块属于 preferredDisplayId 的语义已经收窄成"用户真正选择的 home，只由真实拖拽写入"
// （见 windowPositions.ts WindowPositionsStore.lastDisplayId 字段注释），这里的
// resolveStartupDisplay 落到最大显示器只是这一次的启动决定，不构成用户选择，因此不写回。
// windowBehavior.ts 的 evaluateChatPresence 用同一个 resolveStartupDisplay 调用，保证跟这里
// 算出的落点一致，见该函数内注释
function resolveChatStartupBounds(): Bounds {
  const displays = screen.getAllDisplays()
  const targetDisplay = getEffectiveHomeDisplay(displays, 'chat')
  const stored = getPreferredBounds('chat', targetDisplay.id)
  const bounds = stored ? clampBoundsToWorkArea(stored, targetDisplay.workArea) : computeDefaultChatBounds(targetDisplay, displays)
  if (!stored) {
    setPreferredBounds('chat', targetDisplay.id, bounds)
  }
  return bounds
}

// 聊天窗口 resize 事件的防抖间隔：拖拽缩放期间 'resize' 会连续触发，跟 'moved' 共用同一个
// handleWindowMoved 落盘路径，但不做防抖会导致一次缩放动作触发几十次同步磁盘写入

function createWindow(): BrowserWindow {
  const { x, y, width, height } = resolveChatStartupBounds()

  // 同 createOverlayWindow：构造即程序放置，先进冷却期再建窗口
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
    // Fix 2（second rework pass）：同 createOverlayWindow 的 'closed' 处理，见该处注释——
    // 聊天窗口在当前 Windows 运行时下实际不会走到这条销毁路径（close 只隐藏，
    // window-all-closed 直接 app.quit()），但 FIX 5 之后 app.on('activate') 确实可能重建它，
    // 精确清理不依赖"这条路径今天走不走得到"这个前提
    clearDragState('chat')
  })

  win.on('minimize', () => {
    overlayWindow?.showInactive()
  })

  win.on('focus', () => {
    overlayWindow?.hide()
  })

  // 问题1（buzzing-frolicking-eich.md）：用户真实拖动聊天窗口时，把拖动后的位置写回
  // 持久化偏好表（见 windowBehavior.ts handleWindowMoved 的判定逻辑）
  win.on('moved', () => {
    handleWindowMoved('chat', win, mainWindow, overlayWindow)
  })

  // 拖拽缩放同样要写回持久化偏好表，与 'moved' 共用 handleWindowMoved。防抖、跳屏守卫、
  // 窗口已销毁的判断全部收在该函数内部——两个监听在一次拖拽里都是逐帧连续触发的（从上边/
  // 左边拖拽缩放时原点也在动，会一路发 move），闸门放在公共入口才不会只保护住其中一种
  win.on('resize', () => {
    handleWindowMoved('chat', win, mainWindow, overlayWindow)
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

  return win
}

// 悬浮窗侧点击恢复聊天窗口：单向通知，不需要返回值，用 ipcMain.on 而非 handle
ipcMain.on('overlay:activate', () => {
  mainWindow?.show()
  mainWindow?.focus()
  overlayWindow?.hide()
})

// Stage 3 part 2（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"鼠标 hover Edge 可让角色
// 临时展开"）：渲染层只上报"现在算不算 hover"，真正决定要不要移动窗口、移到哪由
// windowBehavior.ts 的 requestOverlayEdgeHover 决定（含"不是 EDGE 时忽略"这条守卫），这里
// 只做类型层面的最小校验再转发——同 'titlebar:set-overlay' 处理器的既有风格，不让渲染层传来
// 的非法值在 ipcMain.on 的同步回调里引发未捕获异常
ipcMain.on('overlay:edge-hover', (_event, hovered: unknown) => {
  requestOverlayEdgeHover(overlayWindow, mainWindow, hovered === true)
})

// 悬浮窗渲染层挂载完成（含重载后重新挂载）、且已经注册好 'desktop-presence:changed' 监听
// 之后发这条信号，换回一次当前 presence——见 windowBehavior.ts
// sendCurrentPetPresenceOnReady 头注释里完整的安全性论证（含 Fix 2：为什么必须传 mainWindow，
// 渲染层重新挂载会强制清空 overlayEdgeHovered 并重新求值一次）
ipcMain.on('overlay:presence-ready', () => {
  sendCurrentPetPresenceOnReady(overlayWindow, mainWindow)
})

// 主题变化时更新聊天窗口原生按钮条带（TDD §3.2.2「渲染层消费」路径 3、§3.7 附「聊天
// 窗口 chrome 模型」）：渲染层用 src/chat/themeVars.ts 的 titlebarOverlayFromTheme 算好
// { color, symbolColor } 后单向下发，这里只负责转调 win.setTitleBarOverlay()，不做颜色
// 计算。setTitleBarOverlay 只在构造时已启用 WCO（titleBarStyle: 'hidden' + 传了
// titleBarOverlay）的窗口上生效，createWindow 里已满足这个前提。渲染层是本仓库唯一的
// 调用方，值来自 themeVars.ts 而非用户可任意输入的表单，这里只做类型层面的最小校验
ipcMain.on('titlebar:set-overlay', (_event, overlay: { color?: unknown; symbolColor?: unknown }) => {
  // isDestroyed()：mainWindow 只在 'closed' 回调里被置 null，而那回调发生在原生窗口销毁**之后**，
  // 中间那段窗口非空但已销毁。与本文件其它跨异步使用窗口引用的地方同一守卫
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (typeof overlay?.color !== 'string' || typeof overlay?.symbolColor !== 'string') return
  // setTitleBarOverlay 在颜色串格式非法、或窗口未启用 WCO 时会抛。当前唯一调用方是本仓库
  // 渲染层、值来自 themeVars.ts，格式可控；但这是个暴露给渲染层的通道，而 ipcMain.on 里的
  // 同步抛出会变成主进程未捕获异常——不值得为一次配色更新冒这个险
  try {
    mainWindow.setTitleBarOverlay({ color: overlay.color, symbolColor: overlay.symbolColor })
  } catch (err) {
    console.error('[Titlebar] Failed to apply overlay:', err)
  }
})

app.whenReady().then(() => {
  // 启动门控（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"启动门控"一节，阶段②）：
  // DisplayStateMap 不跨应用重启存活，preferredDisplayId 却跨存活——重启这一刻世界模型是
  // 空的、home 却是确定的，若 home 屏上此刻正跑着一个"当前不是前台"的全屏程序，小人会
  // 直接落在它上面。SHQueryUserNotificationState 是全局查询，只在这里调用一次；
  // shouldDistrustHomeAtStartup 命中时关闭门控，evaluatePetPresence（windowBehavior.ts）
  // 会在门控重新打开之前跳过 Pet 的落点/显示——只影响 Pet，Chat 窗口的初始显示不受此约束
  // （见该函数头注释）。门控由两者之一重新打开：下面 startActiveWindowMonitoring 里第一次
  // external 观测到达，或此处设置的有界超时（STARTUP_GATE_TIMEOUT_MS，理由见
  // electron/main/startupGate.ts）
  if (shouldDistrustHomeAtStartup(queryUserNotificationState())) {
    closeStartupGate()
    setTimeout(() => {
      openStartupGate()
      evaluateDesktopPresence(mainWindow, overlayWindow)
    }, STARTUP_GATE_TIMEOUT_MS)
  }

  Menu.setApplicationMenu(null)
  const chatWindow = createWindow()
  // 悬浮窗跟随聊天窗口的最小化/焦点/关闭状态显隐（见上方 createWindow 内的
  // minimize/focus/close 监听）
  overlayWindow = createOverlayWindow()
  // 拖拽起止信号（Stage 3 起两个窗口都挂钩，见 electron/main/windowDragMonitor.ts 头注释）：
  // 悬浮窗这一路除了驱动 electron/main/dragActivity.ts（供 resolver/校验模式使用），还要直传
  // 悬浮窗渲染层（IPC，不经核心服务，见 docs/MintBot_TDD.md §3.7 附「拖拽的实现方式」）——这是
  // 窗口本地的展示事件，走 HTTP→SSE 既慢又会把 core 拖进一件与它无关的事情；转场锁、no-drag
  // 切换等判断全部留给渲染层，主进程只转发，渲染层这条 IPC 契约本身不变。悬浮窗这轮只在启动时
  // 创建一次（没有像聊天窗口那样的重建路径），因此不保留返回的 unhook 函数
  // Fix 1（second rework pass）：noteDragStart/noteDragEnd 现在按窗口分开记（见
  // electron/main/dragActivity.ts 头部注释），因此两个调用点必须各自传入自己的 windowKey——
  // 悬浮窗传 'overlay'，聊天窗口传 'chat'。IPC 转发（overlay:drag-start/-end）保持字节不变，
  // 只是额外挂了这一个 windowKey 参数，不影响渲染层
  //
  // Fix 2（third rework pass，windowBehavior.ts）：onDragStart 现在还额外调用
  // cancelProgrammaticMoveOnDragStart(windowKey)——用户抓住窗口这一刻就是权威的，必须立刻结束
  // 任何仍在给这个窗口 setBounds 的程序化动画，见该函数与 windowAnimation.ts onInterrupt 定义处
  // 关于这次改动的说明。放在 noteDragStart 之后调用：两者是独立状态，顺序不影响正确性，这里
  // 遵循"先记录拖拽状态、再处理副作用"的既有顺序
  startWindowDragMonitor(
    overlayWindow,
    () => {
      noteDragStart('overlay')
      cancelProgrammaticMoveOnDragStart('overlay')
      overlayWindow?.webContents.send('overlay:drag-start')
    },
    () => {
      noteDragEnd('overlay')
      // 主动收敛不挂在这里：此刻最后一次 'moved' 与 300ms 落盘防抖都还没跑完，落点尚未确定。
      // 它挂在 windowBehavior.ts 的 persistBoundsNow 三条终点上，见 reconcileAfterDragPlacement
      overlayWindow?.webContents.send('overlay:drag-end')
    }
  )
  // 聊天窗口这一路只驱动 dragActivity.ts——聊天窗口没有悬浮窗那套立绘/转场状态机，不需要把
  // 起止信号转发给它的渲染层；持久化偏好表的拖拽合法性校验（persistBoundsNow/
  // resolveDragOutcome）与聊天窗口一样要经过 isWindowDragInProgress('chat')，见
  // windowBehavior.ts
  startWindowDragMonitor(
    chatWindow,
    () => {
      noteDragStart('chat')
      cancelProgrammaticMoveOnDragStart('chat')
    },
    () => noteDragEnd('chat')
  )
  // 托盘骨架先于 applyIconFromCurrentPreset 创建，保证该函数末尾的 tray?.setImage 生效时
  // tray 已存在（createTray 内部第一行同步执行 new Tray(...)，之后才有异步的菜单构建）
  createTray()

  // 两个窗口都创建完之后设置启动时的初始图标，拉取一次悬浮窗行为策略配置，并订阅之后的
  // preset 切换 / window-behavior-changed 事件（fire-and-forget，不阻塞启动；三者内部都已
  // try/catch，失败只 console.error）
  applyIconFromCurrentPreset()
  initWindowBehaviorConfig(mainWindow, overlayWindow)
  subscribeToCoreEvents()

  globalShortcut.register('CommandOrControl+Shift+I', () => {
    BrowserWindow.getFocusedWindow()?.webContents.openDevTools()
  })

  powerMonitor.on('lock-screen', () => {
    notifySystemEvent('lock-screen')
    stopActiveWindowMonitoring()
    // Fix 2（second rework pass）：锁屏是 dragActivity.ts 有界恢复要覆盖的三条中断路径之一——
    // Windows 的模态移动/缩放循环可能被锁屏切换打断而收不到 WM_EXITSIZEMOVE，锁屏这一刻本身
    // 也没有任何"用户仍在拖拽"的意义可言，清掉两个窗口的拖拽状态是精确、廉价的
    clearDragState('overlay')
    clearDragState('chat')
  })
  powerMonitor.on('unlock-screen', () => {
    notifySystemEvent('unlock-screen')
    startActiveWindowMonitoring()
    // Fix 2：解锁同理——即使锁屏时漏清（例如信号本身没送达），解锁这一刻也不该再相信一段
    // 跨越了整次锁屏的"拖拽仍在进行中"
    clearDragState('overlay')
    clearDragState('chat')
  })

  // Stage 1 世界模型（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机（Desktop Presence，四阶段
  // 重设计）」"锁屏与解锁"一节）：显示器拓扑变化（插拔/分辨率变化）时立即补一次
  // DisplayStateMap 校验，不必等下一次 1500ms 轮询——见 foregroundWorldModel.ts
  // revalidateBlockersNow 头部注释，拓扑变化的"重新归属/丢弃已不存在的显示器"由校验循环
  // 内部 screen.getDisplayMatching 现查的性质自然覆盖，这里只负责触发时机。
  //
  // ⚠️ 有意的例外，不要"修好"：这三个监听器不跟着 startActiveWindowMonitoring/
  // stopActiveWindowMonitoring 的锁屏生命周期走（不在 lock-screen 时暂停），TDD 原文——
  // "显示器拓扑变化…触发的复查是有意不受锁屏门控的例外：拓扑变了就该立刻重新归属 blocker，
  // 与锁没锁屏无关，代价只是对少数已知 blocker 各探一次"。但同一段话后半句"监听器必须在
  // 应用退出时注销，避免在 screen 模块拆除过程中仍然探测"要求它们仍然跟着应用的生命周期
  // 走（will-quit 时注销），见下方 app.on('will-quit', ...) 里的 screen.removeListener
  screen.on('display-added', handleDisplayTopologyChange)
  screen.on('display-removed', handleDisplayTopologyChange)
  screen.on('display-metrics-changed', handleDisplayTopologyChange)

  // 真正的 relocate/隐藏/置顶/白名单黑名单逻辑见 electron/main/windowBehavior.ts
  // （buzzing-frolicking-eich.md 计划子任务③，Stage 2 起改为 resolver + diff）。
  // mainWindow/overlayWindow 在闭包里按引用读取，每次 tick 拿到的都是调用时刻的当前值，
  // 不会因为窗口重建/置空而脱节
  startActiveWindowMonitoring()

  // 启动时无条件求一次桌面呈现——startBlockerValidationLoop 的 onValidated 回调已经在
  // Windows 上做了同一件事（见 foregroundWorldModel.ts 该函数头注释），但那条循环在非
  // Windows 平台上是纯 no-op（不调用 onValidated），这里的显式调用保证所有平台都至少有一次
  // 启动求值——门控关闭时这次调用对 Pet 是 no-op（见 evaluatePetPresence），不会绕过门控
  evaluateDesktopPresence(mainWindow, overlayWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // Fix 5（second rework pass）：这是 createWindow() 的第二个调用点（见
      // windowDragMonitor.ts 头部注释的更正）——此前没有挂拖拽钩子，重建出的聊天窗口拖拽起止
      // 信号会静默收不到。不可达路径 ≠ 不存在的调用点：非 darwin 上 window-all-closed 直接
      // app.quit()，这条分支今天走不到，但一旦那条前提改变，这里必须已经是对的，而不是留一个
      // 只是"目前没人踩到"的坑
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
  globalShortcut.unregisterAll()
  stopActiveWindowMonitoring()
  // Finding D（Stage 1 review）：display-topology 监听器不跟着 stopActiveWindowMonitoring
  // 的锁屏生命周期走（见上方注册处的注释），但仍必须在应用真正退出时注销，避免 will-quit
  // 之后、进程实际退出之前 screen 模块可能正在拆除的这段时间里还有探测触发
  screen.removeListener('display-added', handleDisplayTopologyChange)
  screen.removeListener('display-removed', handleDisplayTopologyChange)
  screen.removeListener('display-metrics-changed', handleDisplayTopologyChange)
  // 停止 subscribeToCoreEvents 的重连循环：置位阻止发起新一轮连接尝试，并清掉可能正在
  // 等待中的退避定时器——不清掉的话，退出时若循环恰好处于等待退避的阶段，这个 setTimeout
  // 会继续持有事件循环的引用（进程不能真正退出）并在到期后触发一次没有意义的重连
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