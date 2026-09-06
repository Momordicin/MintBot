import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

// 问题1（buzzing-frolicking-eich.md）：跳屏尺寸/位置持久化查表，取代"临时算出来"的跳屏
// 目标。每块显示器上每个窗口的位置/尺寸是一份持久化的、只由用户拖动才会更新的偏好记录——
// 跳屏时只是查表，查到的值恒定不变，不管跳多少次、跳多快，都不会累积漂移（根因见
// windowBehavior.ts 里 moveToNonFullscreenDisplay 的调用点注释）。
//
// 纯 Electron 主进程自己的窗口摆放缓存，跟核心服务的 config.json/设置页毫无关系，不走
// HTTP，不复用 services/core/config/index.ts 的 WindowBehaviorConfig——这里独立维护一份
// 极小的同步本地 JSON store，跟 index.ts/windowBehavior.ts 各自独立定义 PinMode/
// WindowBehaviorConfig 同样的"两边本就该各自独立"的约定。

export type WindowKey = 'chat' | 'overlay'

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

// 两个窗口在全局密度锚点（pickFinestDisplay 选出的那块屏，见下方）上应有的尺寸——换算
// 所有其它屏幕尺寸的起点。悬浮窗尺寸是这轮实现的默认值，不是 TDD 写死的架构决定（写死的
// 只有 alwaysOnTop/transparent/frame 三项，见 docs/MintBot_TDD.md §3.7），聊天窗口尺寸
// 同理。两者原先分别定义在 index.ts 里，现在 windowBehavior.ts 的跳屏/归位也需要同一份
// 数值才能算出"这块屏该多大"，遂搬到这个模块统一持有，index.ts 改为从这里导入，避免两处
// 各自维护同一个数字、日后改一处忘了改另一处
export const DEFAULT_WINDOW_SIZE: Record<WindowKey, { width: number; height: number }> = {
  chat: { width: 290, height: 520 },
  overlay: { width: 132, height: 132 },
}

interface WindowPositionsStore {
  chat: Record<string, Bounds>
  overlay: Record<string, Bounds>
  // 「最近一次用过哪块显示器」——纯运行时缓存字段（同文件头部约定：无迁移机制，陌生/
  // 缺失形状一律退化成默认值，不抛错）。跟 chat/overlay 两张 Bounds 表分开维护：那两张表
  // 回答的是「这块显示器上偏好的位置/尺寸是多少」，这个字段回答的是另一个问题——
  // 「上次退出时窗口停在哪块显示器上」，首次启动 / 记录的显示器已经不存在时由调用方退回
  // 最大显示器（见 pickLargestDisplay/resolveStartupDisplay）
  lastDisplayId: { chat: number | null; overlay: number | null }
}

function getFilePath(): string {
  return path.join(app.getPath('userData'), 'window-positions.json')
}

// 懒加载：首次访问（getPreferredBounds/setPreferredBounds 任一个）时读盘一次，之后常驻内存，
// 每次写入都同步更新这份缓存再落盘——跟 services/core/config/index.ts 的 currentXxxConfig
// 内存缓存同一套模式
let cache: WindowPositionsStore | null = null

function load(): WindowPositionsStore {
  if (cache) return cache

  try {
    const raw = JSON.parse(fs.readFileSync(getFilePath(), 'utf-8'))
    const rawLastDisplayId = raw && typeof raw.lastDisplayId === 'object' && raw.lastDisplayId !== null ? raw.lastDisplayId : {}
    cache = {
      chat: raw && typeof raw.chat === 'object' && raw.chat !== null ? raw.chat : {},
      overlay: raw && typeof raw.overlay === 'object' && raw.overlay !== null ? raw.overlay : {},
      lastDisplayId: {
        chat: typeof rawLastDisplayId.chat === 'number' ? rawLastDisplayId.chat : null,
        overlay: typeof rawLastDisplayId.overlay === 'number' ? rawLastDisplayId.overlay : null,
      },
    }
  } catch {
    // 文件不存在（首次运行）/ JSON 损坏，都按空表处理，不阻塞窗口管理逻辑
    cache = { chat: {}, overlay: {}, lastDisplayId: { chat: null, overlay: null } }
  }

  return cache
}

// 原子写：临时文件 + 同目录 rename，跟 services/core/config/index.ts 的 writeConfigSection
// 同一套约定——这里没有访问那个模块的权限（主进程与核心服务是完全独立的两个运行时），
// 是这个约定的一份独立实现，不是共享代码
function persist(store: WindowPositionsStore): void {
  const filePath = getFilePath()
  const tempPath = `${filePath}.tmp-${crypto.randomUUID()}`
  try {
    fs.writeFileSync(tempPath, JSON.stringify(store, null, 2))
    fs.renameSync(tempPath, filePath)
  } catch (err) {
    try {
      fs.rmSync(tempPath, { force: true })
    } catch {
      // 清理失败不应掩盖上面的原始错误
    }
    throw err
  }
}

export function getPreferredBounds(windowKey: WindowKey, displayId: number): Bounds | null {
  const store = load()
  return store[windowKey][String(displayId)] ?? null
}

export function setPreferredBounds(windowKey: WindowKey, displayId: number, bounds: Bounds): void {
  const store = load()
  store[windowKey][String(displayId)] = bounds
  persist(store)
}

// 「上次退出时在用哪块显示器」的读写：跟 getPreferredBounds/setPreferredBounds 分开维护
// （见 WindowPositionsStore.lastDisplayId 字段注释）。写入时机见 electron/main/index.ts
// 里 createWindow/createOverlayWindow 启动时的一次性记录，以及 windowBehavior.ts
// handleWindowMoved 在用户真实拖动/缩放时的持续更新——不在跳屏/归位路径上调用，
// 避免把 dodge-fullscreen 的临时躲避目的地误记成"上次退出时的位置"
export function getLastDisplayId(windowKey: WindowKey): number | null {
  const store = load()
  return store.lastDisplayId[windowKey]
}

export function setLastDisplayId(windowKey: WindowKey, displayId: number): void {
  const store = load()
  store.lastDisplayId[windowKey] = displayId
  persist(store)
}

// 首次在某块屏幕出现时的默认值：只算这一次，调用方算完立刻 setPreferredBounds 存表，
// 之后永远查表不再重算。
//
// 密度指标改为「物理像素」而不是单纯的 scaleFactor：Electron 的 Display 不暴露物理英寸
// 尺寸，没法算真正的 PPI，只能退而求其次——用 bounds（DIP）× scaleFactor 换算出物理像素
// 宽高，再相乘得到这块屏幕总共有多少个物理像素，作为「够不够细腻」的代理指标。两块屏分辨率
// 相同、只是 scaleFactor 不同时，这个指标退化成跟旧版本等价的比较（两者面积比恰好是
// scaleFactor 比的平方）
const SCALE_DIFF_RATIO_THRESHOLD = 0.2

function physicalPixelArea(display: Electron.Display): number {
  const physicalWidth = display.bounds.width * display.scaleFactor
  const physicalHeight = display.bounds.height * display.scaleFactor
  return physicalWidth * physicalHeight
}

// 全局锚点：当前连接的显示器里物理像素最多（最「细腻」）的那一块。两个默认尺寸（聊天
// 290×520、悬浮窗 132×132）就是「在这块屏上应该长这样」，其余每块屏的尺寸都从这块屏换算
// 而来——不管窗口是从哪块屏跳过来的，同一块目标屏永远换算出同一个尺寸（历史无关，不再
// 像旧版本那样以"恰好从哪块屏跳过来"当基准，跨屏来回多次也不会累积误差）
export function pickFinestDisplay(displays: Electron.Display[]): Electron.Display {
  return displays.reduce((finest, candidate) =>
    physicalPixelArea(candidate) > physicalPixelArea(finest) ? candidate : finest
  )
}

// 20% 阈值判定改为全局：不再是"目标屏 vs 恰好从哪块屏跳过来"这种历史相关的局部比较，而是
// "当前连接的所有显示器两两之间，密度差是否超过 20%"。数学上这等价于只看密度最高与最低的
// 那一对：对任意两块屏 x, y（density 分别在 [min, max] 区间内），|x-y| ≤ max-min 且
// x, y ≥ min，故 |x-y|/min(x,y) ≤ (max-min)/min——只要端点这一对不超阈值，其余任何一对都
// 不会超，因此一次 O(n) 扫描端点即可，不需要真的两两比较
function isDensityHeterogeneous(displays: Electron.Display[]): boolean {
  if (displays.length < 2) return false
  const densities = displays.map(physicalPixelArea)
  const min = Math.min(...densities)
  const max = Math.max(...densities)
  return (max - min) / min > SCALE_DIFF_RATIO_THRESHOLD
}

// 「这块屏该多大」的唯一答案——启动恢复、跳屏、归位三处都必须经过这一个函数，不能各算
// 各的（那正是旧版本的问题：跳屏路径按"恰好从哪块屏跳过来"现算，启动路径完全不缩放，
// 同一块目标屏在不同调用路径下会得到不同答案）。
//
// ≤20%（当前连接的显示器里任意两块的密度差都不超过阈值）：视为同一档，所有屏统一用
// defaultSize，不做任何换算；>20%：按 sqrt(该屏密度 / 锚点密度) 换算宽高——密度是面积
// （正比于线性尺寸的平方），开方后还原成线性缩放比例，保证换算前后宽高比不失真，退化到
// "两屏分辨率相同、只是 scaleFactor 不同"的情形时与旧版本直接用 scaleFactor 比例的结果
// 一致
export function computeSizeForDisplay(
  display: Electron.Display,
  displays: Electron.Display[],
  defaultSize: { width: number; height: number }
): { width: number; height: number } {
  if (!isDensityHeterogeneous(displays)) {
    return { width: defaultSize.width, height: defaultSize.height }
  }

  const anchor = pickFinestDisplay(displays)
  const ratio = Math.sqrt(physicalPixelArea(display) / physicalPixelArea(anchor))
  return {
    width: Math.round(defaultSize.width * ratio),
    height: Math.round(defaultSize.height * ratio),
  }
}

// computeSizeForDisplay 的位置版本：贴 workArea 右下角（跟 index.ts createOverlayWindow()
// 原先的算法一致），用上面算出的宽高代入。聊天窗口启动时用的是"居中"而不是这个公式（见
// index.ts computeDefaultChatBounds），两者共享的只是尺寸计算（computeSizeForDisplay），
// 位置公式本来就分属两种不同的默认落点约定，不在这里合并
export function computeDefaultBoundsForDisplay(
  display: Electron.Display,
  displays: Electron.Display[],
  defaultSize: { width: number; height: number }
): Bounds {
  const { width, height } = computeSizeForDisplay(display, displays, defaultSize)

  // 用 workArea（带 x/y 偏移）而不是 workAreaSize：任务栏停靠在上边/左边时 workArea.x/y
  // 不为 0，只用宽高算出来的坐标会跟任务栏厚度错位
  const { x: workAreaX, y: workAreaY, width: workAreaWidth, height: workAreaHeight } = display.workArea
  return {
    x: workAreaX + workAreaWidth - width,
    y: workAreaY + workAreaHeight - height,
    width,
    height,
  }
}

// 启动恢复用的显示器/边界选择——纯函数，只依赖调用方传入的数据（不读 load()/screen），
// 供 electron/main/windowPositions.test.ts 直接单测。真正读 screen.getAllDisplays() 的
// 调用点在 electron/main/index.ts 的 resolveChatStartupBounds/resolveOverlayStartupBounds
// （那两个函数本身因为依赖真实 screen/BrowserWindow，不在这里、也不做单测）

// 按显示器物理分辨率（bounds，不是 workArea）挑面积最大的一块——"最大的显示器"这个措辞
// 指物理尺寸本身，用 workArea 会被任务栏厚度这类无关因素干扰，也不符合"最大显示器"的
// 直觉语义
export function pickLargestDisplay(displays: Electron.Display[]): Electron.Display {
  return displays.reduce((largest, candidate) => {
    const candidateArea = candidate.bounds.width * candidate.bounds.height
    const largestArea = largest.bounds.width * largest.bounds.height
    return candidateArea > largestArea ? candidate : largest
  })
}

// 首次启动（lastDisplayId 为 null）或上次所在的显示器已经不在当前连接的显示器列表里
// （拔掉了显示器 / 两次会话之间 id 变了）时，退回最大显示器；否则用回上次那块
export function resolveStartupDisplay(
  displays: Electron.Display[],
  lastDisplayId: number | null
): Electron.Display {
  const remembered = lastDisplayId !== null ? displays.find(display => display.id === lastDisplayId) : undefined
  return remembered ?? pickLargestDisplay(displays)
}

// 把 bounds 收进 workArea 范围内：尺寸变化（分辨率变了/显示器换了）或显示器重新排列都
// 可能让持久化的旧值落在当前配置下不可达的地方，必须夹紧，不能任由窗口摆到画面外、
// 用户够不到也拖不回来。宽高先收窄到不超过 workArea 本身，坐标再收进
// [workArea 起点, workArea 终点 - 窗口尺寸] 区间——宽高先夹的顺序保证这个区间永远不会
// 出现上界小于下界的情况
export function clampBoundsToWorkArea(bounds: Bounds, workArea: Electron.Rectangle): Bounds {
  const width = Math.min(bounds.width, workArea.width)
  const height = Math.min(bounds.height, workArea.height)
  const maxX = workArea.x + workArea.width - width
  const maxY = workArea.y + workArea.height - height
  const x = Math.min(Math.max(bounds.x, workArea.x), maxX)
  const y = Math.min(Math.max(bounds.y, workArea.y), maxY)
  return { x, y, width, height }
}
