import React, { useEffect, useRef, useState } from 'react'
import { createWatchdogEventSource } from '../eventsWatchdog.js'
import type { AppState } from '../../shared/types/index.js'
import './overlay.css'
import {
  type OverlayManifest,
  type YState,
  deriveY,
  nextThresholdInstant,
} from './portraitState.js'
import {
  type ResolvedTransitionStep,
  type TransitionTrigger,
  isTransitionLocked,
  resolveOverlayDisplayFile,
  resolveTransitionChain,
  selectTransitionTrigger,
  shouldPlayFallAsleep,
  transitionEndInstant,
} from './transitionState.js'
import {
  type EdgeHoverState,
  INITIAL_EDGE_HOVER_STATE,
  EDGE_HOVER_LEAVE_DEBOUNCE_MS,
  onEdgeHoverEnter,
  onEdgeHoverLeave,
  onEdgeHoverDebounceElapsed,
  resetEdgeHoverOnPresenceLeftEdge,
  edgeHoverExpandedChanged,
  isDragHandleSuppressedByEdge,
} from './edgeHoverState.js'

import { CORE_URL } from '../coreUrl.js'

const CLICK_DISPLACEMENT_THRESHOLD_PX = 5

interface EmotionEventPayload {
  self?: { label: string; intensity: number } | null
  perceived_user?: unknown
  sessionId: string
  explicitSleep: boolean
}

type PetPresence = 'ACTIVE' | 'AMBIENT' | 'EDGE' | 'HIDDEN'
interface DesktopPresencePayload {
  presence: PetPresence
  edgeSide: 'left' | 'right' | null
  handleSuppressed: boolean
}

function resolveAssetUrl(characterId: string, relativePath: string): string {
  const encodedPath = relativePath.split('/').map(encodeURIComponent).join('/')
  return `${CORE_URL}/characters/${encodeURIComponent(characterId)}/${encodedPath}`
}

export function OverlayApp() {
  const [characterId, setCharacterId] = useState<string | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [isLocked, setIsLocked] = useState(false)
  const manifestRef = useRef<OverlayManifest | undefined>(undefined)
  const yRef = useRef<YState>(null)
  const xRef = useRef<string | undefined>(undefined)
  const ownSessionIdRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const loadGenRef = useRef(0)
  const transitionFileRef = useRef<string | null>(null)
  const transitionInProgressRef = useRef<TransitionTrigger | null>(null)
  const transitionEndAtRef = useRef<number | null>(null)
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null)
  const isDraggingRef = useRef(false)
  const dragStartYRef = useRef<YState>(null)

  const [isHandleVisible, setIsHandleVisible] = useState(false)
  const [isDragHandleSuppressed, setIsDragHandleSuppressed] = useState(false)
  const handleHideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const presenceRef = useRef<DesktopPresencePayload>({ presence: 'AMBIENT', edgeSide: null, handleSuppressed: false })
  const edgeHoverStateRef = useRef<EdgeHoverState>(INITIAL_EDGE_HOVER_STATE)
  const edgeHoverTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  function applyEdgeHoverState(next: EdgeHoverState) {
    const previous = edgeHoverStateRef.current
    edgeHoverStateRef.current = next
    if (edgeHoverExpandedChanged(previous, next)) {
      window.electronAPI.requestOverlayEdgeHover(next.expanded)
    }
    setIsDragHandleSuppressed(isDragHandleSuppressedByEdge(presenceRef.current.handleSuppressed, next.expanded))
  }

  function scheduleEdgeHoverCollapse(collapseAt: number) {
    if (edgeHoverTimerRef.current !== undefined) {
      clearTimeout(edgeHoverTimerRef.current)
    }
    edgeHoverTimerRef.current = setTimeout(() => {
      edgeHoverTimerRef.current = undefined
      applyEdgeHoverState(onEdgeHoverDebounceElapsed(edgeHoverStateRef.current, Date.now()))
    }, Math.max(0, collapseAt - Date.now()))
  }

  function handleEdgeHoverEnter() {
    if (presenceRef.current.presence !== 'EDGE') return
    if (edgeHoverTimerRef.current !== undefined) {
      clearTimeout(edgeHoverTimerRef.current)
      edgeHoverTimerRef.current = undefined
    }
    applyEdgeHoverState(onEdgeHoverEnter(edgeHoverStateRef.current))
  }

  function handleEdgeHoverLeave() {
    if (presenceRef.current.presence !== 'EDGE') return
    if (!edgeHoverStateRef.current.expanded) return 
    const next = onEdgeHoverLeave(edgeHoverStateRef.current, Date.now(), EDGE_HOVER_LEAVE_DEBOUNCE_MS)
    edgeHoverStateRef.current = next 
    scheduleEdgeHoverCollapse(next.pendingCollapseAt!)
  }

  function scheduleThresholdCheck(lastAttentionAt: number | null) {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current)
      timerRef.current = undefined
    }
    const next = nextThresholdInstant(lastAttentionAt, Date.now())
    if (next === null) return
    timerRef.current = setTimeout(() => loadCharacterAndPortrait(true), Math.max(0, next - Date.now()))
  }

  function loadCharacterAndPortrait(calledByThresholdTimer: boolean) {
    const gen = ++loadGenRef.current
    const previousY = yRef.current

    fetch(`${CORE_URL}/state`)
      .then(r => r.json())
      .then((state: AppState) => {
        if (gen !== loadGenRef.current) return
        const id = state.presetSnapshot?.characterId
        if (!id) return
        setCharacterId(id)
        ownSessionIdRef.current = state.sessionId

        yRef.current = deriveY({
          lastAttentionAt: state.lastAttentionAt,
          explicitSleep: state.explicitSleep,
          now: Date.now(),
        })
        xRef.current = state.emotion?.self?.label
        scheduleThresholdCheck(state.lastAttentionAt)

        return fetch(`${CORE_URL}/characters/${encodeURIComponent(id)}/manifest.json`)
          .then(r => r.json())
          .then((manifest: OverlayManifest) => {
            if (gen !== loadGenRef.current) return
            manifestRef.current = manifest
            if (shouldPlayFallAsleep({
              calledByThresholdTimer,
              previousY,
              nextY: yRef.current,
              explicitSleep: state.explicitSleep,
            })) {
              startTransition('fall-asleep')
              return
            }
            setFile(resolveOverlayDisplayFile(manifestRef.current, transitionFileRef.current, isDraggingRef.current, yRef.current, xRef.current))
          })
      })
      .catch(() => {
      })
  }

  function playTransitionStep(steps: ResolvedTransitionStep[], index: number) {
    if (index >= steps.length) {
      endTransition()
      return
    }
    const step = steps[index]
    transitionFileRef.current = step.file
    setFile(step.file)
    transitionTimerRef.current = setTimeout(() => playTransitionStep(steps, index + 1), step.durationMs)
  }

  function endTransition() {
    if (transitionTimerRef.current !== undefined) {
      clearTimeout(transitionTimerRef.current)
      transitionTimerRef.current = undefined
    }
    transitionFileRef.current = null
    transitionInProgressRef.current = null
    transitionEndAtRef.current = null
    setIsLocked(false)
    loadCharacterAndPortrait(false)
  }

  function startTransition(trigger: TransitionTrigger) {
    if (trigger === 'fall-asleep' && isTransitionLocked(transitionEndAtRef.current, Date.now())) {
      return
    }

    if (transitionTimerRef.current !== undefined) {
      clearTimeout(transitionTimerRef.current)
      transitionTimerRef.current = undefined
    }
    transitionInProgressRef.current = null
    transitionFileRef.current = null
    transitionEndAtRef.current = null
    setIsLocked(false)

    const steps = resolveTransitionChain(manifestRef.current, trigger)
    if (steps.length === 0) {
      setFile(resolveOverlayDisplayFile(manifestRef.current, null, isDraggingRef.current, yRef.current, xRef.current))
      return
    }
    transitionInProgressRef.current = trigger
    transitionEndAtRef.current = trigger === 'fall-asleep' ? null : transitionEndInstant(steps, Date.now())
    setIsLocked(isTransitionLocked(transitionEndAtRef.current, Date.now()))
    playTransitionStep(steps, 0)
  }

  function scheduleHandleHide() {
    if (handleHideTimerRef.current !== undefined) {
      clearTimeout(handleHideTimerRef.current)
    }
    handleHideTimerRef.current = setTimeout(() => {
      handleHideTimerRef.current = undefined
      if (isDraggingRef.current) return 
      setIsHandleVisible(false)
    }, 400)
  }

  function handlePortraitMouseEnter() {
    if (handleHideTimerRef.current !== undefined) {
      clearTimeout(handleHideTimerRef.current)
      handleHideTimerRef.current = undefined
    }
    setIsHandleVisible(true)
    handleEdgeHoverEnter()
  }

  function handlePortraitMouseLeave() {
    scheduleHandleHide()
    handleEdgeHoverLeave()
  }

  function handleMouseDown(event: React.MouseEvent) {
    mouseDownPosRef.current = { x: event.clientX, y: event.clientY }
  }

  function handlePortraitClick(event: React.MouseEvent) {
    const start = mouseDownPosRef.current
    mouseDownPosRef.current = null
    if (start) {
      const displaced = Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_DISPLACEMENT_THRESHOLD_PX
      if (displaced) return 
    }

    if (isTransitionLocked(transitionEndAtRef.current, Date.now())) return 

    if (transitionInProgressRef.current === 'fall-asleep') {
      if (transitionTimerRef.current !== undefined) {
        clearTimeout(transitionTimerRef.current)
        transitionTimerRef.current = undefined
      }
      transitionInProgressRef.current = null
      transitionFileRef.current = null

      fetch(`${CORE_URL}/internal/overlay-interaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'portrait-click' }),
      }).catch(() => {})

      const now = Date.now()
      yRef.current = deriveY({ lastAttentionAt: now, explicitSleep: false, now })
      scheduleThresholdCheck(now)
      setFile(resolveOverlayDisplayFile(manifestRef.current, null, isDraggingRef.current, yRef.current, xRef.current))
      return
    }

    if (yRef.current === 'boredom-idle' || yRef.current === 'sleeping') {
      const trigger = selectTransitionTrigger(yRef.current)
      fetch(`${CORE_URL}/internal/overlay-interaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'portrait-click' }),
      }).catch(() => {})

      const now = Date.now()
      yRef.current = deriveY({ lastAttentionAt: now, explicitSleep: false, now })
      scheduleThresholdCheck(now)

      startTransition(trigger)
      return
    }

    window.electronAPI.activateFromOverlay()
  }

  function handleDragStart() {
    if (transitionInProgressRef.current === 'fall-asleep') {
      if (transitionTimerRef.current !== undefined) {
        clearTimeout(transitionTimerRef.current)
        transitionTimerRef.current = undefined
      }
      transitionInProgressRef.current = null
      transitionFileRef.current = null
      yRef.current = null
    }

    dragStartYRef.current = yRef.current
    isDraggingRef.current = true
    setFile(resolveOverlayDisplayFile(manifestRef.current, transitionFileRef.current, true, yRef.current, xRef.current))
  }

  function handleDragEnd() {
    isDraggingRef.current = false
    scheduleHandleHide()
    const capturedY = dragStartYRef.current
    dragStartYRef.current = null

    fetch(`${CORE_URL}/internal/overlay-interaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'drag-end' }),
    }).catch(() => {})

    const now = Date.now()
    yRef.current = deriveY({ lastAttentionAt: now, explicitSleep: false, now })
    scheduleThresholdCheck(now)

    startTransition(selectTransitionTrigger(capturedY))
  }

  useEffect(() => {
    loadCharacterAndPortrait(false)
    return () => {
      loadGenRef.current++
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current)
      }
      if (transitionTimerRef.current !== undefined) {
        clearTimeout(transitionTimerRef.current)
      }
      if (handleHideTimerRef.current !== undefined) {
        clearTimeout(handleHideTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState !== 'hidden') return
      const wasDragging = isDraggingRef.current
      isDraggingRef.current = false
      dragStartYRef.current = null
      if (wasDragging) scheduleHandleHide()
      if (transitionInProgressRef.current !== null) {
        endTransition()
      } else if (wasDragging) {
        setFile(resolveOverlayDisplayFile(manifestRef.current, null, false, yRef.current, xRef.current))
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  useEffect(() => {
    const unsubscribeStart = window.electronAPI.onOverlayDragStart(handleDragStart)
    const unsubscribeEnd = window.electronAPI.onOverlayDragEnd(handleDragEnd)
    return () => {
      unsubscribeStart()
      unsubscribeEnd()
    }
  }, [])

  useEffect(() => {
    function handleDesktopPresenceChanged(payload: DesktopPresencePayload) {
      presenceRef.current = payload
      if (payload.presence !== 'EDGE') {
        if (edgeHoverTimerRef.current !== undefined) {
          clearTimeout(edgeHoverTimerRef.current)
          edgeHoverTimerRef.current = undefined
        }
        edgeHoverStateRef.current = resetEdgeHoverOnPresenceLeftEdge()
      }
      setIsDragHandleSuppressed(isDragHandleSuppressedByEdge(payload.handleSuppressed, edgeHoverStateRef.current.expanded))
    }

    const unsubscribe = window.electronAPI.onDesktopPresenceChanged(handleDesktopPresenceChanged)
    window.electronAPI.notifyOverlayReady()

    return () => {
      unsubscribe()
      if (edgeHoverTimerRef.current !== undefined) {
        clearTimeout(edgeHoverTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    function handleEmotionEvent(event: MessageEvent) {
      try {
        const data: EmotionEventPayload = JSON.parse(event.data)

        if (ownSessionIdRef.current === null || data.sessionId !== ownSessionIdRef.current) return

        if ('self' in data) {
          xRef.current = data.self?.label
        }

        const now = Date.now()
        yRef.current = deriveY({ lastAttentionAt: now, explicitSleep: data.explicitSleep, now })
        scheduleThresholdCheck(now)
        dragStartYRef.current = null

        setFile(resolveOverlayDisplayFile(manifestRef.current, transitionFileRef.current, isDraggingRef.current, yRef.current, xRef.current))
      } catch {
      }
    }

    function handlePresetSwitchedEvent() {
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current)
        timerRef.current = undefined
      }
      if (transitionTimerRef.current !== undefined) {
        clearTimeout(transitionTimerRef.current)
        transitionTimerRef.current = undefined
      }
      transitionFileRef.current = null
      transitionInProgressRef.current = null
      transitionEndAtRef.current = null
      setIsLocked(false)
      isDraggingRef.current = false
      dragStartYRef.current = null
      if (handleHideTimerRef.current !== undefined) {
        clearTimeout(handleHideTimerRef.current)
        handleHideTimerRef.current = undefined
      }
      setIsHandleVisible(false)
      manifestRef.current = undefined
      yRef.current = null
      xRef.current = undefined
      ownSessionIdRef.current = null
      setFile(null)
      loadCharacterAndPortrait(false)
    }

    const watchdog = createWatchdogEventSource({
      url: `${CORE_URL}/events`,
      listeners: {
        emotion: handleEmotionEvent,
        'preset-switched': handlePresetSwitchedEvent,
      },
      onOpen: () => {
        loadCharacterAndPortrait(false)
      },
    })

    return () => {
      watchdog.close()
    }
  }, [])

  const src = file && characterId ? resolveAssetUrl(characterId, file) : null

  return (
    <div className={`overlay-root${isLocked ? ' overlay-root--locked' : ''}`}>
      {src && (
        <img
          className="overlay-portrait"
          src={src}
          alt=""
          onMouseDown={handleMouseDown}
          onClick={handlePortraitClick}
          onMouseEnter={handlePortraitMouseEnter}
          onMouseLeave={handlePortraitMouseLeave}
        />
      )}
      <div
        className={`overlay-drag-handle${
          isDragHandleSuppressed
            ? ' overlay-drag-handle--edge-suppressed'
            : isHandleVisible
              ? ' overlay-drag-handle--visible'
              : ''
        }`}
      />
    </div>
  )
}
