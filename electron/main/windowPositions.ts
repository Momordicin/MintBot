import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

// 问题1（buzzing-frolicking-eich.md）：跳屏尺寸/位置持久化查表，取代"临时算出来"的跳屏
// 目标。每块显示器上每个窗口的位置/尺寸是一份持久化的、只由用户拖动才会更新的偏好记录——
// 跳屏时只是查表，查到的值恒定不变，不管跳多少次、跳多快，都不会累积漂移（根因见
// windowBehavior.ts 里 moveToDisplay 的调用点注释——Stage 2 起改名，见该函数头注释：
// 选目标显示器现在是 resolver 的职责，这个函数只负责移动到调用方给定的目标）。
//
// 纯 Electron 主进程自己的窗口摆放缓存，跟核心服务的 config.json/设置页毫无关系，不走
// HTTP，不复用 services/core/config/index.ts 的 WindowBehaviorConfig——这里独立维护一份
// 极小的同步本地 JSON store，跟 index.ts/windowBehavior.ts 各自独立定义 PinMode/
// WindowBehaviorConfig 同样的"两边本就该各自独立"的约定。

export type WindowKey = 'chat' | 'overlay'

// Fix 4（second rework pass）：单一权威定义，供 windowBehavior.ts（落盘防抖）与
// dragActivity.ts（推导 DRAG_END_TAIL_MS）共用——此前两个文件各自维护一份数值必须一致的
// 常量，靠注释手动钉住"改一处记得改另一处"，是本项目一直在清理的那类漂移。放在这里而不是
// 两者之一，是因为本文件已经是两者共同的、无循环 import 风险的叶子模块（只 import
// electron/fs/path/crypto），跟 DEFAULT_WINDOW_SIZE 是同一个先例——那个常量同样由 index.ts
// 与 windowBehavior.ts 共用，同样放在这里
export const PERSIST_DEBOUNCE_MS = 300

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
  // Stage 2（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"Placement：用户的「家」与自动
  // 避让的位置彻底分离"一节）：这个字段现在是 preferredDisplayId——用户真正选择的 home
  // display，只由真实拖拽写入（见 getPreferredDisplayId/commitUserChosenHomeDisplay 与
  // electron/main/desktopPresence.ts 的 resolveDragOutcome），自动避让/跳屏/归位一律不写。
  // 磁盘字段名沿用旧名 lastDisplayId 不改——本文件开头已声明这是一份无迁移机制的纯运行时
  // 缓存，形状陌生/缺失时直接退化成默认值（首次启动退回最大显示器，见
  // pickLargestDisplay/resolveStartupDisplay），改字段名不会导致任何数据损坏或需要迁移，
  // 只是老用户的这一份记忆在这次升级后重新从"最大显示器"起步，可以接受。
  //
  // 语义变化（取代旧的"上次退出时窗口停在哪块显示器上，冲突解除时把当前屏采纳为下次启动
  // 的家"）：旧模型用 setLastDisplayId 在冲突解除时"猜"新家，是本次重设计明确取消的行为
  // （TDD 原文："旧实现用 setLastDisplayId 在冲突解除时「把当前所在屏采纳为下次启动的家」，
  // 是在猜，本设计取消这一猜测"）。现在只有 handleWindowMoved 里跑过
  // resolveDragOutcome 的真实拖拽（且拖拽发生在"待在家"状态下、落到了另一块屏）才会写这
  // 个字段，见 windowBehavior.ts persistBoundsNow
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

// 原始读取，刻意不导出——理由跟下面 writeHomeDisplayId 不导出是对称的一条，只是方向相反。
// 这个值在用户从未真正拖动过窗口时是 null，而"这个窗口此刻的家是哪块屏"这个问题**永远有
// 答案**（没有记录就退回最大显示器）。两者曾经同时可见，于是调用点各自拼装
// `resolveStartupDisplay(displays, getPreferredDisplayId(key))` 这个两步算式——一共拼了五遍，
// 其中一遍漏了，直接产出过一个真实缺陷：新档案上 getPreferredDisplayId 恒为 null，
// persistBoundsNow 据此把 temporaryRelocation 算成 false，于是"自动避让期间的拖拽"被当成
// "在家拖拽"，把一块临时屏提交成了持久化的家——正好绕过 commitUserChosenHomeDisplay 这道门
// 存在的全部理由（门管住了"谁能写"，管不住"决定要不要写的那个判断本身是错的"）。
// 现在模块外只剩 getEffectiveHomeDisplay 一个读法，那个算式无处可拼
function getPreferredDisplayId(windowKey: WindowKey): number | null {
  const store = load()
  return store.lastDisplayId[windowKey]
}

// 「这个窗口此刻的家是哪块屏」——唯一对外的 home 读取口，恒有答案，不可能为 null。
// electron/main/index.ts 的启动恢复与 windowBehavior.ts 的 evaluatePetPresence /
// evaluateChatPresence / persistBoundsNow / notePlacement 全部经这里，因此它们对"家"的定义
// 按构造就是同一个，不再是五份各自维护、迟早漂移的等价算式
export function getEffectiveHomeDisplay(displays: Electron.Display[], windowKey: WindowKey): Electron.Display {
  return resolveStartupDisplay(displays, getPreferredDisplayId(windowKey))
}

// 原始写入，刻意不导出：模块之外没有任何路径能绕过 commitUserChosenHomeDisplay 直接改这
// 个字段，把"只能从一个门进来"变成编译期事实，而不是靠命名/注释这类约定
function writeHomeDisplayId(windowKey: WindowKey, displayId: number): void {
  const store = load()
  store.lastDisplayId[windowKey] = displayId
  persist(store)
}

// docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"Placement：用户的「家」与自动避让的位置彻底
// 分离"一节的核心不变量："自动避让只修改 currentDisplayId 并置 temporaryRelocation = true，
// 永远不写入任何偏好——不会把自动避难屏偷偷记成新家"。这是磁盘上 preferredDisplayId
// 唯一允许的写入口。
//
// 不叫 setPreferredDisplayId：那个名字读起来跟 setPreferredBounds（例行的、每次落点都可能
// 触发的坐标更新）没有区别，会让"从自动路径调它"显得平平无奇——本函数的名字必须读成"正在
// 提交一次用户认定的长期家"，让下一个读到调用点的人在被诱惑之前先意识到这不是一次普通赋值。
//
// 唯一合法调用方是 electron/main/homeDisplayCommit.ts 的
// commitHomeDisplayFromDragOutcome（真实拖拽 → resolveDragOutcome 判定"待在家时拖到另一块
// 屏"才会调用，见该文件与 windowBehavior.ts persistBoundsNow）。这条约束由
// windowPositionsCommitGuard.test.ts 的 import 边界检查守卫——见该文件头注释里对"抓得住/
// 抓不住什么"的诚实说明
export function commitUserChosenHomeDisplay(windowKey: WindowKey, displayId: number): void {
  writeHomeDisplayId(windowKey, displayId)
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
//
// windowKey 是可选的第四个参数（review 发现的问题1b）：聊天窗口首次启动走的是上面提到的
// "居中"公式，不经过这里；但聊天窗口的 Desktop Presence resolver（Stage 2 起取代
// dodge-fullscreen 分支的实现，见 windowBehavior.ts evaluateChatPresence）relocate 到一块
// 从未去过的显示器时确实会经过这里（windowBehavior.ts 的 moveToDisplay，悬浮窗与聊天窗口
// 共用同一个函数）。悬浮窗与聊天窗口各自独立的 resolver 判断是否需要 relocate（不是
// either/or），
// 若两者在同一个 tick 都第一次落到同一块全新显示器上（常见于双屏、且两者跳屏前恰好都在
// 同一块"家"屏幕），排除项相同、目标显示器也会算出相同结果——都贴同一个右下角的话，
// 132×132 的悬浮窗会被 290×520 的聊天窗口默认落点完全包住（同一个角，悬浮窗几何上是
// 聊天窗口的子集）。悬浮窗改贴右上角而不是右下角，与聊天窗口的默认角错开，避免这种重叠；
// 聊天窗口自己的默认落点（windowKey 不是 'overlay' 时）保持右下角不变，不影响任何既有调用
// （省略 windowKey 时同样是右下角，兼容此前所有调用点与既有单测）
export function computeDefaultBoundsForDisplay(
  display: Electron.Display,
  displays: Electron.Display[],
  defaultSize: { width: number; height: number },
  windowKey?: WindowKey
): Bounds {
  const { width, height } = computeSizeForDisplay(display, displays, defaultSize)

  // 用 workArea（带 x/y 偏移）而不是 workAreaSize：任务栏停靠在上边/左边时 workArea.x/y
  // 不为 0，只用宽高算出来的坐标会跟任务栏厚度错位
  const { x: workAreaX, y: workAreaY, width: workAreaWidth, height: workAreaHeight } = display.workArea
  const y = windowKey === 'overlay' ? workAreaY : workAreaY + workAreaHeight - height
  return {
    x: workAreaX + workAreaWidth - width,
    y,
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

// 首次启动（preferredDisplayId 为 null）或 home 显示器已经不在当前连接的显示器列表里
// （拔掉了显示器 / 两次会话之间 id 变了）时，退回最大显示器；否则用回 home
export function resolveStartupDisplay(
  displays: Electron.Display[],
  preferredDisplayId: number | null
): Electron.Display {
  const remembered = preferredDisplayId !== null ? displays.find(display => display.id === preferredDisplayId) : undefined
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
