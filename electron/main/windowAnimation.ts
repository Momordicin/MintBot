import { BrowserWindow, screen } from 'electron'

const FRAME_MS = 16
export const EXIT_DURATION_MS = 250
export const ENTRANCE_DURATION_MS = 250

export const SAME_DISPLAY_TWEEN_DURATION_MS = 160
const OFFSET_PX = 24

const activeCancels = new Map<BrowserWindow, () => void>()

export function isAnimating(win: BrowserWindow): boolean {
  return activeCancels.has(win)
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
  options?: { instant?: boolean }
): () => void {
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
    win.setBounds(target)
    win.setOpacity(1)
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
      win.setBounds(target)
      win.setOpacity(1)
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
          win.setBounds(target)
          win.setOpacity(1)
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
      win.setOpacity(1 - opacity)
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
          win.setBounds(target)
          win.setOpacity(1)
          stopAndUntrack()
          cancelled = true
          onComplete?.()
          return
        }

        const { x, y, opacity } = interpolateFrame(settledStart, target, t, easeEntrance)
        win.setBounds({ x, y, width: target.width, height: target.height })
        win.setOpacity(opacity)
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
