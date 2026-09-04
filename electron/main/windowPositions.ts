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

interface WindowPositionsStore {
  chat: Record<string, Bounds>
  overlay: Record<string, Bounds>
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
    cache = {
      chat: raw && typeof raw.chat === 'object' && raw.chat !== null ? raw.chat : {},
      overlay: raw && typeof raw.overlay === 'object' && raw.overlay !== null ? raw.overlay : {},
    }
  } catch {
    // 文件不存在（首次运行）/ JSON 损坏，都按空表处理，不阻塞窗口管理逻辑
    cache = { chat: {}, overlay: {} }
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

// 首次在某块屏幕出现时的默认值：只算这一次，调用方算完立刻 setPreferredBounds 存表，
// 之后永远查表不再重算。
//
// 缩放比例相对差异 ≤20%：直接沿用 baseline 的原始像素宽高，不做任何缩放调整（那点微弱的
// 缩放差别直接忽略）；>20%：按 目标屏scaleFactor/基准屏scaleFactor 比例缩放宽高，取整。
// 位置沿用现有的"贴 workArea 右下角"公式（跟 index.ts createOverlayWindow() 的算法一致），
// 用上面算出的宽高代入
const SCALE_DIFF_RATIO_THRESHOLD = 0.2

export function computeDefaultBoundsForDisplay(
  display: Electron.Display,
  baseline: Bounds,
  baselineDisplay: Electron.Display
): Bounds {
  const scaleDiffRatio = Math.abs(display.scaleFactor - baselineDisplay.scaleFactor) / baselineDisplay.scaleFactor

  let width = baseline.width
  let height = baseline.height
  if (scaleDiffRatio > SCALE_DIFF_RATIO_THRESHOLD) {
    const ratio = display.scaleFactor / baselineDisplay.scaleFactor
    width = Math.round(baseline.width * ratio)
    height = Math.round(baseline.height * ratio)
  }

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
