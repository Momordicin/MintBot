// electron/main/petHandleWindow.ts — 桌宠穿透时的独立手柄小窗口：创建、跟随桌宠定位、显隐
// 用法：index.ts 在创建 overlay 后调 createPetHandleWindow 并自行加载 handle/index.html、交给 windowBehavior.ts 的 setPetHandleWindow；overlay 的 move / resize 事件与 evaluatePetPresence 调 syncPetHandleBounds / setPetHandleVisible
// 形状：createPetHandleWindow(overlay: BrowserWindow, preloadPath: string) -> COLLAPSED_SIZE 见方的 BrowserWindow；syncPetHandleBounds(handle, overlay)；setPetHandleVisible(handle, visible: boolean)
// 对应文件：electron/main/index.ts / electron/main/windowBehavior.ts / electron/main/windowPositions.ts（petHandleBounds / COLLAPSED_SIZE）/ src/handle/index.html / src/handle/main.ts / electron/main/windowBehavior.test.ts / electron/main/petHandleWindow.test.ts
import { BrowserWindow, screen } from 'electron'
import { COLLAPSED_SIZE, petHandleBounds } from './windowPositions'

export function petShapeScaleStale(recorded: number | null, current: number): boolean {
  return recorded !== null && recorded !== current
}

export function currentShapeScale(win: BrowserWindow): number {
  return screen.getDisplayMatching(win.getBounds()).scaleFactor
}

const handleShapeScale = new WeakMap<BrowserWindow, number>()

function reapplyHandleShapeIfScaleChanged(handle: BrowserWindow): void {
  const recorded = handleShapeScale.get(handle) ?? null
  if (recorded === null) return
  const current = currentShapeScale(handle)
  if (!petShapeScaleStale(recorded, current)) return
  handle.setShape([{ x: 0, y: 0, width: COLLAPSED_SIZE, height: COLLAPSED_SIZE }])
  handleShapeScale.set(handle, current)
}

export function createPetHandleWindow(overlay: BrowserWindow, preloadPath: string): BrowserWindow {
  const handle = new BrowserWindow({
    parent: overlay,
    width: COLLAPSED_SIZE,
    height: COLLAPSED_SIZE,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: false,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    webPreferences: {
      preload: preloadPath
    }
  })
  handle.setShape([{ x: 0, y: 0, width: COLLAPSED_SIZE, height: COLLAPSED_SIZE }])
  handleShapeScale.set(handle, currentShapeScale(handle))
  return handle
}

export function syncPetHandleBounds(handle: BrowserWindow, overlay: BrowserWindow): void {
  if (handle.isDestroyed() || overlay.isDestroyed()) return
  const pet = overlay.getBounds()
  const workArea = screen.getDisplayMatching(pet).workArea
  handle.setBounds(petHandleBounds(pet, workArea))
  reapplyHandleShapeIfScaleChanged(handle)
}

export function setPetHandleVisible(handle: BrowserWindow, visible: boolean): void {
  if (handle.isDestroyed()) return
  if (visible && !handle.isVisible()) {
    handle.showInactive()
    reapplyHandleShapeIfScaleChanged(handle)
  }
  else if (!visible && handle.isVisible()) handle.hide()
}
