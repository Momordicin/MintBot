// src/chat/ChatWindow.tsx — 聊天窗口主界面：加载当前预设与历史消息，发送消息并读取回复，按预设显示配置应用壁纸、头像与主题色
// 用法：App 渲染 <ChatWindow />；GET /state、/ai-available、/messages、/characters/:id/manifest.json，POST /chat（读 SSE：message_done / system），GET /events（preset-switched）；调用 electronAPI.setTitlebarOverlay / notifyChatReady / onChatShown / notifyChatPainted
// 对应文件：src/App.tsx / src/chat/MessageList.tsx / src/chat/InputBar.tsx / src/chat/TitleBar.tsx / src/chat/MessageBubble.tsx / src/chat/sse.ts / src/chat/theme.ts / src/eventsWatchdog.ts / src/errorText.ts / services/core/index.ts / services/core/routes/chat.ts / services/core/routes/messages.ts / services/core/routes/status.ts / services/core/routes/events.ts / electron/main/index.ts（titlebar:set-overlay / chat:ready / chat:painted）/ electron/main/chatReveal.ts（chat:shown）
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageList } from './MessageList'
import { InputBar, type InputBarHandle, type VoiceInputState } from './InputBar'
import { TitleBar } from './TitleBar'
import { MessageData } from './MessageBubble'
import { parseSSE } from './sse'
import { deriveTheme } from './theme.js'
import { DEFAULT_CHAT_BG_OPACITY, DEFAULT_THEME_INPUT, resolveThemeMode, themeCssVars, titlebarOverlayFromTheme } from './themeVars.js'
import { usePrefersDark } from '../usePrefersDark.js'
import { createWatchdogEventSource } from '../eventsWatchdog.js'
import type { AppState, PresetSnapshot } from '../../shared/types/index.js'
import type { ErrorBody } from '../../shared/errorCodes.js'
import { errorText } from '../errorText.js'
import './chat.css'

import { CORE_URL, resolveAssetUrl } from '../coreUrl.js'
const DEFAULT_WALLPAPER_URL = `${CORE_URL}/wallpapers/bg.jpg`
const WALLPAPER_TIMING_ID = 'chat-wallpaper'
const INITIAL_HISTORY_LIMIT = 3
const LOAD_MORE_HISTORY_LIMIT = 20
const AVATAR_DIM_AFTER_MS = 20 * 60 * 1000

type AvatarDimMode = 'none' | 'startup' | 'switch'

let localMessageSeq = 0
function nextLocalMessageId(): string {
  localMessageSeq += 1
  return `local-${localMessageSeq}`
}

interface HistoryMessage {
  id: number
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
}

interface MessagesPageResponse {
  messages: HistoryMessage[]
  hasMore: boolean
}

function toMessageData(m: HistoryMessage): MessageData {
  return { id: String(m.id), role: m.role, content: m.content, createdAt: m.createdAt }
}

function wallpaperUrlFor(snapshot: PresetSnapshot | null): string {
  return snapshot?.wallpaperPath
    ? `${CORE_URL}/wallpapers/${encodeURIComponent(snapshot.wallpaperPath)}`
    : DEFAULT_WALLPAPER_URL
}

function fetchAiAvailable(): Promise<boolean> {
  return fetch(`${CORE_URL}/ai-available`)
    .then(r => r.json())
    .then((data: { aiAvailable: boolean }) => data.aiAvailable)
    .catch(() => false)
}

interface AvatarUrls {
  avatarUrl?: string
  userAvatarUrl?: string
}

async function fetchAvatarUrls(characterId: string, signal?: AbortSignal): Promise<AvatarUrls> {
  try {
    const res = await fetch(`${CORE_URL}/characters/${encodeURIComponent(characterId)}/manifest.json`, { signal })
    if (!res.ok) return {}

    const manifest: { avatar?: string; userAvatar?: string } = await res.json()
    return {
      avatarUrl: manifest.avatar ? resolveAssetUrl(characterId, manifest.avatar) : undefined,
      userAvatarUrl: manifest.userAvatar ? resolveAssetUrl(characterId, manifest.userAvatar) : undefined
    }
  } catch {
    return {}
  }
}

export function ChatWindow() {
  const { t, i18n } = useTranslation()
  const hasFetched = useRef(false)
  const [messages, setMessages] = useState<MessageData[]>([])
  const [isReplying, setIsReplying] = useState(false)
  const [appState, setAppState] = useState<AppState | null>(null)
  const prefersDark = usePrefersDark()
  const [avatarDimmed, setAvatarDimmed] = useState<boolean>(true)
  const [wallpaperUrl, setWallpaperUrl] = useState<string | null>(null)
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(undefined)
  const [userAvatarUrl, setUserAvatarUrl] = useState<string | undefined>(undefined)
  const [hasMoreHistory, setHasMoreHistory] = useState(false)
  const [initialLoadSignal, setInitialLoadSignal] = useState(0)
  const oldestMessageIdRef = useRef<number | null>(null)
  const isLoadingMoreRef = useRef(false)
  const activeControllersRef = useRef<Set<AbortController>>(new Set())
  const sessionSyncControllerRef = useRef<AbortController | null>(null)
  const appStateRef = useRef<AppState | null>(null)
  const avatarDimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startupHandledRef = useRef(false)
  const [bootParts, setBootParts] = useState({ state: false, wallpaper: false, history: false })
  const wallpaperPreloadStartedRef = useRef(false)
  const chatReadyNotifiedRef = useRef(false)
  const [revealToken, setRevealToken] = useState(0)
  const inputBarRef = useRef<InputBarHandle>(null)
  const paintedRevealTokenRef = useRef(0)
  const [voice, setVoice] = useState<VoiceInputState | null>(null)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const voiceLoadSeqRef = useRef(0)

  function markBootPart(part: 'state' | 'wallpaper' | 'history') {
    setBootParts(prev => (prev[part] ? prev : { ...prev, [part]: true }))
  }

  useEffect(() => {
    appStateRef.current = appState
  }, [appState])

  useEffect(() => clearAvatarDimTimer, [])

  useEffect(() => {
    if (hasFetched.current) return
    hasFetched.current = true

    fetch(`${CORE_URL}/state`)
      .then(r => r.json())
      .then((state: AppState) => {
        if (startupHandledRef.current) {
          markBootPart('state')
          return
        }
        startupHandledRef.current = true
        const controller = new AbortController()
        sessionSyncControllerRef.current = controller

        setAppState(state)
        appStateRef.current = state
        setWallpaperUrl(wallpaperUrlFor(state.presetSnapshot))
        if (state.presetSnapshot?.characterId) {
          fetchAvatarUrls(state.presetSnapshot.characterId, controller.signal).then(urls => {
            if (controller.signal.aborted) return
            setAvatarUrl(urls.avatarUrl)
            setUserAvatarUrl(urls.userAvatarUrl)
          })
        }
        beginSession(state, true, controller.signal)
        markBootPart('state')
      })
      .catch(() => {
        addSystemMessage(i18n.t('无法连接核心服务，请确认服务已启动'), true)
        markBootPart('state')
        markBootPart('history')
      })
  }, [])

  useEffect(() => {
    if (!bootParts.state || wallpaperPreloadStartedRef.current) return
    wallpaperPreloadStartedRef.current = true
    if (!wallpaperUrl) {
      markBootPart('wallpaper')
      return
    }
    const image = new Image()
    image.src = wallpaperUrl
    image.decode().then(() => markBootPart('wallpaper'), () => markBootPart('wallpaper'))
  }, [bootParts.state, wallpaperUrl])

  useEffect(() => {
    if (!bootParts.state || !bootParts.wallpaper || !bootParts.history || chatReadyNotifiedRef.current) return
    chatReadyNotifiedRef.current = true
    const markShown = () => setRevealToken(token => Math.max(token, 1))
    window.electronAPI.notifyChatReady().then(markShown, markShown)
  }, [bootParts])

  const takeVoiceText = useCallback(async () => {
    try {
      const response = await fetch(`${CORE_URL}/voice/take`, { method: 'POST' })
      if (!response.ok) return
      const { texts } = await response.json() as { texts: string[] }
      if (texts.length === 0) return
      inputBarRef.current?.appendVoice(texts)
    } catch {
    }
  }, [])

  const refreshVoice = useCallback(async () => {
    const seq = ++voiceLoadSeqRef.current
    try {
      const response = await fetch(`${CORE_URL}/voice/status`)
      if (!response.ok) return
      const { installed, listenEnabled, mode, install } = await response.json() as Omit<VoiceInputState, 'installing'> & { install: { state: string } }
      if (seq !== voiceLoadSeqRef.current) return
      setVoice({ installed, listenEnabled, mode, installing: install.state === 'installing' })
    } catch {
    }
  }, [])

  const toggleVoice = useCallback(async () => {
    if (!voice) return
    setVoiceBusy(true)
    try {
      await fetch(`${CORE_URL}/voice/listen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !voice.listenEnabled }),
      })
    } catch {
    }
    await refreshVoice()
    setVoiceBusy(false)
  }, [voice, refreshVoice])

  useEffect(() => window.electronAPI.onChatShown(() => {
    setRevealToken(token => token + 1)
    takeVoiceText()
    refreshVoice()
  }), [])

  useEffect(() => {
    if (revealToken === 0 || paintedRevealTokenRef.current === revealToken) return
    const notifyPainted = () => {
      if (paintedRevealTokenRef.current === revealToken) return
      paintedRevealTokenRef.current = revealToken
      window.electronAPI.notifyChatPainted()
    }
    if (!wallpaperUrl) {
      requestAnimationFrame(() => requestAnimationFrame(notifyPainted))
      return
    }
    const observer = new PerformanceObserver(list => {
      const painted = list.getEntries().some(entry => (entry as PerformanceEntry & { identifier?: string }).identifier === `${WALLPAPER_TIMING_ID}-${revealToken}`)
      if (!painted) return
      observer.disconnect()
      notifyPainted()
    })
    observer.observe({ type: 'element', buffered: true })
    return () => observer.disconnect()
  }, [revealToken, wallpaperUrl])

  useEffect(() => {
    const syncSessionOnFocus = async () => {
      try {
        const response = await fetch(`${CORE_URL}/state`)
        const state: AppState = await response.json()

        setAppState(state)
        setWallpaperUrl(wallpaperUrlFor(state.presetSnapshot))

        const isStartup = !startupHandledRef.current
        if (!isStartup && state.sessionId === appStateRef.current?.sessionId) return
        startupHandledRef.current = true
        appStateRef.current = state
        if (!isStartup) clearAvatarDimTimer()

        activeControllersRef.current.forEach(controller => controller.abort())
        activeControllersRef.current.clear()

        sessionSyncControllerRef.current?.abort()
        const controller = new AbortController()
        sessionSyncControllerRef.current = controller

        setAvatarUrl(undefined)
        setUserAvatarUrl(undefined)
        setMessages([])
        setHasMoreHistory(false)
        oldestMessageIdRef.current = null
        isLoadingMoreRef.current = false
        beginSession(state, isStartup, controller.signal)

        const nextUrls: AvatarUrls = state.presetSnapshot?.characterId
          ? await fetchAvatarUrls(state.presetSnapshot.characterId, controller.signal)
          : {}
        if (controller.signal.aborted) return
        setAvatarUrl(nextUrls.avatarUrl)
        setUserAvatarUrl(nextUrls.userAvatarUrl)
      } catch {
      }
    }

    const handler = () => {
      syncSessionOnFocus()
      takeVoiceText()
      refreshVoice()
    }
    window.addEventListener('focus', handler)

    const watchdog = createWatchdogEventSource({
      url: `${CORE_URL}/events`,
      listeners: {
        'preset-switched': () => {
          syncSessionOnFocus()
        },
        'voice-pending': () => {
          takeVoiceText()
        },
        'voice-status-changed': () => {
          refreshVoice()
        },
      },
      onOpen: () => {
        syncSessionOnFocus()
        takeVoiceText()
        refreshVoice()
      },
    })

    return () => {
      window.removeEventListener('focus', handler)
      watchdog.close()
    }
  }, [])

  const displayConfig = appState?.presetSnapshot?.displayConfig

  const resolvedMode = displayConfig ? resolveThemeMode(displayConfig.themeMode, prefersDark) : DEFAULT_THEME_INPUT.mode
  const theme = useMemo(() => {
    if (!displayConfig) return deriveTheme(DEFAULT_THEME_INPUT)
    return deriveTheme({
      accentRgb: displayConfig.accentRgb,
      mode: resolvedMode,
      tintStrength: displayConfig.tintStrength,
    })
  }, [displayConfig, resolvedMode])
  const chatBgOpacity = displayConfig?.chatBgOpacity ?? DEFAULT_CHAT_BG_OPACITY

  useEffect(() => {
    window.electronAPI.setTitlebarOverlay(titlebarOverlayFromTheme(theme))
  }, [theme])

  useLayoutEffect(() => {
    const root = document.documentElement
    const vars = themeCssVars(theme, chatBgOpacity)
    for (const [name, value] of Object.entries(vars)) {
      root.style.setProperty(name, value)
    }
    root.style.colorScheme = resolvedMode === 'day' ? 'light' : 'dark'
  }, [theme, chatBgOpacity, resolvedMode])

  function clearAvatarDimTimer() {
    if (avatarDimTimerRef.current !== null) {
      clearTimeout(avatarDimTimerRef.current)
      avatarDimTimerRef.current = null
    }
  }

  function armAvatarDimTimer(delayMs: number) {
    clearAvatarDimTimer()
    avatarDimTimerRef.current = setTimeout(() => {
      avatarDimTimerRef.current = null
      setAvatarDimmed(true)
    }, delayMs)
  }

  function syncAvatarDim(lastChatMessageAt: number) {
    const remainingMs = AVATAR_DIM_AFTER_MS - (Date.now() - lastChatMessageAt)
    if (remainingMs <= 0) {
      clearAvatarDimTimer()
      setAvatarDimmed(true)
      return
    }
    setAvatarDimmed(false)
    armAvatarDimTimer(remainingMs)
  }

  function applyNoHistoryAvatarDim(mode: AvatarDimMode, signal: AbortSignal) {
    if (mode === 'none' || signal.aborted) return
    if (mode === 'startup') {
      setAvatarDimmed(false)
      armAvatarDimTimer(AVATAR_DIM_AFTER_MS)
      return
    }
    fetchAiAvailable().then(available => {
      if (signal.aborted) return
      if (available) {
        setAvatarDimmed(false)
        armAvatarDimTimer(AVATAR_DIM_AFTER_MS)
      } else {
        clearAvatarDimTimer()
        setAvatarDimmed(true)
      }
    })
  }

  function beginSession(state: AppState, isStartup: boolean, signal: AbortSignal) {
    let mode: AvatarDimMode = 'switch'
    if (isStartup) {
      if (state.aiAvailable) {
        mode = 'startup'
      } else {
        mode = 'none'
        clearAvatarDimTimer()
        setAvatarDimmed(true)
      }
    }
    if (state.sessionId) {
      loadInitialMessages(state.sessionId, signal, mode)
    } else {
      applyNoHistoryAvatarDim(mode, signal)
      markBootPart('history')
    }
  }

  async function loadInitialMessages(sessionId: string, signal: AbortSignal, mode: AvatarDimMode) {
    try {
      const response = await fetch(
        `${CORE_URL}/messages?sessionId=${encodeURIComponent(sessionId)}&limit=${INITIAL_HISTORY_LIMIT}`,
        { signal }
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const page: MessagesPageResponse = await response.json()
      if (signal.aborted) return

      setMessages(prev => prev.length === 0 ? page.messages.map(toMessageData) : [...page.messages.map(toMessageData), ...prev])
      setHasMoreHistory(page.hasMore)
      oldestMessageIdRef.current = page.messages[0]?.id ?? null
      setInitialLoadSignal(n => n + 1)
      if (mode !== 'none') {
        const lastChatMessage = page.messages.filter(m => m.role !== 'system').pop()
        if (lastChatMessage) {
          syncAvatarDim(lastChatMessage.createdAt)
        } else {
          applyNoHistoryAvatarDim(mode, signal)
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      addSystemMessage(i18n.t('加载历史消息失败'), true)
      applyNoHistoryAvatarDim(mode, signal)
    } finally {
      markBootPart('history')
    }
  }

  async function loadMoreMessages() {
    const sessionId = appState?.sessionId
    const beforeId = oldestMessageIdRef.current
    if (!sessionId || !hasMoreHistory || isLoadingMoreRef.current || beforeId === null) return

    isLoadingMoreRef.current = true
    const signal = sessionSyncControllerRef.current?.signal
    try {
      const response = await fetch(
        `${CORE_URL}/messages?sessionId=${encodeURIComponent(sessionId)}&limit=${LOAD_MORE_HISTORY_LIMIT}&beforeId=${beforeId}`,
        signal ? { signal } : undefined
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const page: MessagesPageResponse = await response.json()
      if (signal?.aborted) return

      setMessages(prev => [...page.messages.map(toMessageData), ...prev])
      setHasMoreHistory(page.hasMore)
      if (page.messages.length > 0) {
        oldestMessageIdRef.current = page.messages[0].id
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        addSystemMessage(i18n.t('加载历史消息失败'), true)
      }
    } finally {
      isLoadingMoreRef.current = false
    }
  }

  function addSystemMessage(content: string, isError = false) {
    setMessages(prev => [...prev, {
      id: nextLocalMessageId(),
      role: 'system' as const,
      content,
      createdAt: Date.now(),
      isError,
    }])
  }

  const sendMessage = useCallback(async (text: string) => {
    setMessages(prev => [...prev, {
      id: nextLocalMessageId(),
      role: 'user' as const,
      content: text,
      createdAt: Date.now(),
    }])
    setIsReplying(true)

    const controller = new AbortController()
    activeControllersRef.current.add(controller)

    try {
      const response = await fetch(`${CORE_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      for await (const { event, data } of parseSSE(response)) {
        if (controller.signal.aborted) break

        if (event === 'message_done') {
          const { messageId, text: replyText, sessionId: replySessionId } = data as { messageId: string; text: string; sessionId: string }
          if (replySessionId !== appStateRef.current?.sessionId) continue
          setMessages(prev => [...prev, {
            id: String(messageId),
            role: 'assistant' as const,
            content: replyText,
            createdAt: Date.now(),
          }])
          fetchAiAvailable().then(available => {
            if (replySessionId !== appStateRef.current?.sessionId) return
            if (available) {
              setAvatarDimmed(false)
              armAvatarDimTimer(AVATAR_DIM_AFTER_MS)
            } else {
              clearAvatarDimTimer()
              setAvatarDimmed(true)
            }
          })
        }

        if (event === 'system') {
          const { payload, sessionId: replySessionId } = data as { type: string; payload: ErrorBody; sessionId: string }
          if (replySessionId !== appStateRef.current?.sessionId) continue
          addSystemMessage(errorText(payload, i18n.t), true)
        }

      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        addSystemMessage(i18n.t('回复失败，请稍后重试'), true)
      }
    } finally {
      activeControllersRef.current.delete(controller)
      setIsReplying(activeControllersRef.current.size > 0)
    }
  }, [])

  const displayName = appState?.presetSnapshot?.name ?? t('角色')

  return (
    <div
      className={`chat-window${avatarDimmed ? ' chat-window--avatar-dimmed' : ''}`}
    >
      {wallpaperUrl && revealToken > 0 && (
        <img
          key={revealToken}
          className="chat-window__wallpaper"
          src={wallpaperUrl}
          alt=""
          draggable={false}
          {...{ elementtiming: `${WALLPAPER_TIMING_ID}-${revealToken}` }}
        />
      )}
      <TitleBar avatarUrl={avatarUrl} displayName={displayName} />

      {appState?.ollamaReady === false && (
        <div className="banner banner--warn">
          {t('Ollama 未运行，请先启动 Ollama')}
        </div>
      )}

      <div className="chat-area">
        <MessageList
          key={appState?.sessionId ?? 'no-session'}
          messages={messages}
          isReplying={isReplying}
          avatarUrl={avatarUrl}
          userAvatarUrl={userAvatarUrl}
          displayName={displayName}
          hasMoreHistory={hasMoreHistory}
          onLoadMore={loadMoreMessages}
          scrollToBottomSignal={initialLoadSignal}
        />
      </div>

      <div className="input-area">
        <InputBar ref={inputBarRef} onSend={sendMessage} voice={voice} voiceBusy={voiceBusy} onToggleVoice={toggleVoice} />
      </div>
    </div>
  )
}
