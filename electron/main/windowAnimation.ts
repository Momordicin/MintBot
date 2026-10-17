// electron/main/windowAnimation.ts — BrowserWindow 位置移动动画：同显示器内补间，跨显示器则滑出淡出、瞬移、滑入淡入
// 用法：animateTo(win, target, onComplete, { instant, finalOpacity }) 返回 cancel 函数（立即落到目标并回调 onComplete）；窗口 minimize / hide / close 时同样落到目标；isAnimating(win) 查询；chatReveal.ts 调 finishAnimation(win) / fadeIn(win, durationMs)
// 对应文件：electron/main/windowBehavior.ts（moveToDisplay、贴边移动、拖拽回滚）/ electron/main/chatReveal.ts / electron/main/windowAnimation.test.ts
import { BrowserWindow, screen } from 'electron'

const FRAME_MS = 16
export const EXIT_DURATION_MS = 250
export const ENTRANCE_DURATION_MS = 250

export const SAME_DISPLAY_TWEEN_DURATION_MS = 160
const OFFSET_PX = 24

const activeCancels = new Map<BrowserWindow, () => void>()

function settleOnTarget(win: BrowserWindow, target: Electron.Rectangle, opacity: number): void {
  const current = win.getBounds()
  if (current.x !== target.x || current.y !== target.y || current.width !== target.width || current.height !== target.height) {
    win.setBounds(target)
  }
  if (win.getOpacity() !== opacity) win.setOpacity(opacity)
}

export function isAnimating(win: BrowserWindow): boolean {
  return activeCancels.has(win)
}

export function finishAnimation(win: BrowserWindow): void {
  activeCancels.get(win)?.()
}

export function easeInOut(p: number): number {
  const clamped = Math.min(Math.max(p, 0), 1)
  return clamped * clamped * (3 - 2 * clamped)
}

export function fadeIn(win: BrowserWindow, durationMs: number): void {
  if (win.isDestroyed() || activeCancels.has(win)) return
  const fadeStart = Date.now()
  let timer: ReturnType<typeof setTimeout> | null = null

  function finish(): void {
    if (timer) clearTimeout(timer)
    activeCancels.delete(win)
    if (!win.isDestroyed() && win.getOpacity() !== 1) win.setOpacity(1)
  }

  function frame(): void {
    if (win.isDestroyed()) {
      activeCancels.delete(win)
      return
    }
    const t = Math.min((Date.now() - fadeStart) / durationMs, 1)
    if (t >= 1) {
      finish()
      return
    }
    win.setOpacity(easeInOut(t))
    timer = setTimeout(frame, FRAME_MS)
  }

  activeCancels.set(win, finish)
  timer = setTimeout(frame, 0)
}

export function evaluateAnimationGuards(
  srcDisplayId: number,
  dstDisplayId: number
): { sameDisplay: boolean } {
  return { sameDisplay: srcDisplayId === dstDisplayId }
}

export function computeOffsetStartRect(
  target: Electron.Rectangle,
  workArea: Electron.Rectangle
): Electron.Rectangle {
  const roomAbove = target.y - workArea.y
  const roomBelow = workArea.y + workArea.height - (target.y + target.height)
  const offset =
    roomAbove >= OFFSET_PX ? -OFFSET_PX
    : roomBelow >= OFFSET_PX ? OFFSET_PX
    : 0
  return {
    x: target.x,
    y: target.y + offset,
    width: target.width,
    height: target.height,
  }
}

export function easeEntrance(p: number): number {
  const clamped = Math.min(Math.max(p, 0), 1)
  const s = Math.cbrt(clamped)
  return s * s * (3 - 2 * s)
}

export function interpolateFrame(
  from: Electron.Rectangle,
  to: Electron.Rectangle,
  t: number,
  easing: (p: number) => number
): { x: number; y: number; opacity: number } {
  const clamped = Math.min(Math.max(t, 0), 1)
  const eased = easing(clamped)
  return {
    x: Math.round(from.x + (to.x - from.x) * eased),
    y: Math.round(from.y + (to.y - from.y) * eased),
    opacity: eased,
  }
}

export function interpolateRect(
  from: Electron.Rectangle,
  to: Electron.Rectangle,
  t: number,
  easing: (p: number) => number
): Electron.Rectangle {
  const clamped = Math.min(Math.max(t, 0), 1)
  const eased = easing(clamped)
  return {
    x: Math.round(from.x + (to.x - from.x) * eased),
    y: Math.round(from.y + (to.y - from.y) * eased),
    width: Math.round(from.width + (to.width - from.width) * eased),
    height: Math.round(from.height + (to.height - from.height) * eased),
  }
}

export function animateTo(
  win: BrowserWindow,
  target: Electron.Rectangle,
  onComplete?: () => void,
  options?: { instant?: boolean; finalOpacity?: number }
): () => void {
  const finalOpacity = options?.finalOpacity ?? 1
  const existingCancel = activeCancels.get(win)
  if (existingCancel) {
    existingCancel()
  }

  let cancelled = false

  if (win.isDestroyed()) {
    cancelled = true
    onComplete?.()
    return () => {}
  }

  if (options?.instant) {
    const start = win.getBounds()
    console.log(
      `[WindowAnimation] Instant move (caller-requested): ` +
        `start=${start.width}x${start.height}@${start.x},${start.y} -> ` +
        `target=${target.width}x${target.height}@${target.x},${target.y}`
    )
    settleOnTarget(win, target, finalOpacity)
    cancelled = true
    onComplete?.()
    return () => {}
  }

  const start = win.getBounds()
  const srcDisplay = screen.getDisplayMatching(start)
  const dstDisplay = screen.getDisplayMatching(target)

  const { sameDisplay } = evaluateAnimationGuards(srcDisplay.id, dstDisplay.id)

  let timer: ReturnType<typeof setTimeout> | null = null

  function removeGuards(): void {
    win.off('minimize', onInterrupt)
    win.off('hide', onInterrupt)
    win.off('close', onInterrupt)
    win.off('closed', onInterrupt)
  }

  function onInterrupt(): void {
    snap()
  }

  function stopAndUntrack(): void {
    if (timer) clearTimeout(timer)
    removeGuards()
    if (activeCancels.get(win) === snap) activeCancels.delete(win)
  }

  function snap(): void {
    if (cancelled) return
    cancelled = true
    stopAndUntrack()
    if (win.isDestroyed()) {
      onComplete?.()
      return
    }
    try {
      settleOnTarget(win, target, finalOpacity)
    } catch (err) {
      console.error('[WindowAnimation] Failed to snap to target:', err)
    }
    onComplete?.()
  }

  win.once('minimize', onInterrupt)
  win.once('hide', onInterrupt)
  win.once('close', onInterrupt)
  win.once('closed', onInterrupt)
  activeCancels.set(win, snap)

  if (sameDisplay) {
    const tweenStart = Date.now()

    function tweenFrame(): void {
      try {
        if (win.isDestroyed()) {
          stopAndUntrack()
          cancelled = true
          onComplete?.()
          return
        }

        const t = Math.min((Date.now() - tweenStart) / SAME_DISPLAY_TWEEN_DURATION_MS, 1)

        if (t >= 1) {
          settleOnTarget(win, target, finalOpacity)
          stopAndUntrack()
          cancelled = true
          onComplete?.()
          return
        }

        win.setBounds(interpolateRect(start, target, t, easeEntrance))
        timer = setTimeout(tweenFrame, FRAME_MS)
      } catch (err) {
        console.error('[WindowAnimation] same-display tween frame failed, snapping to target:', err)
        snap()
      }
    }

    timer = setTimeout(tweenFrame, 0)
    return snap
  }

  const exitEnd = computeOffsetStartRect(start, srcDisplay.workArea)

  const exitStart = Date.now()

  function exitFrame(): void {
    try {
      if (win.isDestroyed()) {
        stopAndUntrack()
        cancelled = true
        onComplete?.()
        return
      }

      const t = Math.min((Date.now() - exitStart) / EXIT_DURATION_MS, 1)

      if (t >= 1) {
        beginTeleportAndEntrance()
        return
      }

      const { x, y, opacity } = interpolateFrame(start, exitEnd, t, easeEntrance)
      win.setBounds({ x, y, width: start.width, height: start.height })
      win.setOpacity(finalOpacity * (1 - opacity))
      timer = setTimeout(exitFrame, FRAME_MS)
    } catch (err) {
      console.error('[WindowAnimation] exit frame failed, snapping to target:', err)
      snap()
    }
  }

  function beginTeleportAndEntrance(): void {
    let offsetStart: Electron.Rectangle
    let settledStart: Electron.Rectangle
    try {
      win.setOpacity(0)

      offsetStart = computeOffsetStartRect(target, dstDisplay.workArea)
      win.setBounds(offsetStart)

      settledStart = win.isDestroyed() ? offsetStart : win.getBounds()
    } catch (err) {
      console.error('[WindowAnimation] Failed to stage the slide-in, falling back to an instant jump:', err)
      snap()
      return
    }

    const entranceStart = Date.now()

    function entranceFrame(): void {
      try {
        if (win.isDestroyed()) {
          stopAndUntrack()
          cancelled = true
          onComplete?.()
          return
        }

        const t = Math.min((Date.now() - entranceStart) / ENTRANCE_DURATION_MS, 1)

        if (t >= 1) {
          settleOnTarget(win, target, finalOpacity)
          stopAndUntrack()
          cancelled = true
          onComplete?.()
          return
        }

        const { x, y, opacity } = interpolateFrame(settledStart, target, t, easeEntrance)
        win.setBounds({ x, y, width: target.width, height: target.height })
        win.setOpacity(finalOpacity * opacity)
        timer = setTimeout(entranceFrame, FRAME_MS)
      } catch (err) {
        console.error('[WindowAnimation] entrance frame failed, snapping to target:', err)
        snap()
      }
    }

    timer = setTimeout(entranceFrame, 0)
  }

  timer = setTimeout(exitFrame, 0)
  return snap
}
