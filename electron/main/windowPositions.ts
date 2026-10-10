import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export type WindowKey = 'chat' | 'overlay'

export const PERSIST_DEBOUNCE_MS = 300

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export const DEFAULT_WINDOW_SIZE: Record<WindowKey, { width: number; height: number }> = {
  chat: { width: 290, height: 520 },
  overlay: { width: 132, height: 132 },
}

interface WindowPositionsStore {
  chat: Record<string, Bounds>
  overlay: Record<string, Bounds>
  lastDisplayId: { chat: number | null; overlay: number | null }
}

function getFilePath(): string {
  return path.join(app.getPath('userData'), 'window-positions.json')
}

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
    cache = { chat: {}, overlay: {}, lastDisplayId: { chat: null, overlay: null } }
  }

  return cache
}

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

function getPreferredDisplayId(windowKey: WindowKey): number | null {
  const store = load()
  return store.lastDisplayId[windowKey]
}

export function getEffectiveHomeDisplay(displays: Electron.Display[], windowKey: WindowKey): Electron.Display {
  return resolveStartupDisplay(displays, getPreferredDisplayId(windowKey))
}

function writeHomeDisplayId(windowKey: WindowKey, displayId: number): void {
  const store = load()
  store.lastDisplayId[windowKey] = displayId
  persist(store)
}

export function commitUserChosenHomeDisplay(windowKey: WindowKey, displayId: number): void {
  writeHomeDisplayId(windowKey, displayId)
}

const SCALE_DIFF_RATIO_THRESHOLD = 0.2

export const OVERLAY_DEFAULT_RIGHT_OFFSET_DIP = 50
export const OVERLAY_DEFAULT_BOTTOM_OFFSET_DIP = 100

function physicalPixelArea(display: Electron.Display): number {
  const physicalWidth = display.bounds.width * display.scaleFactor
  const physicalHeight = display.bounds.height * display.scaleFactor
  return physicalWidth * physicalHeight
}

export function pickFinestDisplay(displays: Electron.Display[]): Electron.Display {
  return displays.reduce((finest, candidate) =>
    physicalPixelArea(candidate) > physicalPixelArea(finest) ? candidate : finest
  )
}

function isDensityHeterogeneous(displays: Electron.Display[]): boolean {
  if (displays.length < 2) return false
  const densities = displays.map(physicalPixelArea)
  const min = Math.min(...densities)
  const max = Math.max(...densities)
  return (max - min) / min > SCALE_DIFF_RATIO_THRESHOLD
}

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

export function computeDefaultBoundsForDisplay(
  display: Electron.Display,
  displays: Electron.Display[],
  defaultSize: { width: number; height: number },
  windowKey: WindowKey
): Bounds {
  const { width, height } = computeSizeForDisplay(display, displays, defaultSize)
  const workArea = display.workArea

  if (windowKey === 'chat') {
    return clampBoundsToWorkArea(
      {
        x: Math.round(workArea.x + (workArea.width - width) / 2),
        y: Math.round(workArea.y + (workArea.height - height) / 2),
        width,
        height,
      },
      workArea
    )
  }

  return clampBoundsToWorkArea(
    {
      x: workArea.x + workArea.width - width - OVERLAY_DEFAULT_RIGHT_OFFSET_DIP,
      y: workArea.y + workArea.height - height - OVERLAY_DEFAULT_BOTTOM_OFFSET_DIP,
      width,
      height,
    },
    workArea
  )
}

export function pickLargestDisplay(displays: Electron.Display[]): Electron.Display {
  return displays.reduce((largest, candidate) => {
    const candidateArea = candidate.bounds.width * candidate.bounds.height
    const largestArea = largest.bounds.width * largest.bounds.height
    return candidateArea > largestArea ? candidate : largest
  })
}

export function resolveStartupDisplay(
  displays: Electron.Display[],
  preferredDisplayId: number | null
): Electron.Display {
  const remembered = preferredDisplayId !== null ? displays.find(display => display.id === preferredDisplayId) : undefined
  return remembered ?? pickLargestDisplay(displays)
}

export function computeAnchoredResizeBounds(
  bounds: Bounds,
  size: { width: number; height: number },
  workArea: Electron.Rectangle
): Bounds {
  return clampBoundsToWorkArea(
    {
      x: Math.round(bounds.x + (bounds.width - size.width) / 2),
      y: bounds.y + bounds.height - size.height,
      width: size.width,
      height: size.height,
    },
    workArea
  )
}

export function clampBoundsToWorkArea(bounds: Bounds, workArea: Electron.Rectangle): Bounds {
  const width = Math.min(bounds.width, workArea.width)
  const height = Math.min(bounds.height, workArea.height)
  const maxX = workArea.x + workArea.width - width
  const maxY = workArea.y + workArea.height - height
  const x = Math.min(Math.max(bounds.x, workArea.x), maxX)
  const y = Math.min(Math.max(bounds.y, workArea.y), maxY)
  return { x, y, width, height }
}
