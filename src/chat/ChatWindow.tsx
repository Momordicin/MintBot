import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MessageList } from './MessageList'
import { InputBar } from './InputBar'
import { TitleBar } from './TitleBar'
import { MessageData } from './MessageBubble'
import { parseSSE } from './sse'
import { deriveTheme } from './theme.js'
import { DEFAULT_CHAT_BG_OPACITY, DEFAULT_THEME_INPUT, resolveThemeMode, themeCssVars, titlebarOverlayFromTheme } from './themeVars.js'
import { usePrefersDark } from '../usePrefersDark.js'
import { createWatchdogEventSource } from '../eventsWatchdog.js'
import type { AppState, PresetSnapshot } from '../../shared/types/index.js'
import './chat.css'

const CORE_URL = 'http://127.0.0.1:3000'
const DEFAULT_WALLPAPER_URL = `${CORE_URL}/wallpapers/bg.jpg`
const INITIAL_HISTORY_LIMIT = 3
const LOAD_MORE_HISTORY_LIMIT = 20

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

function fetchEmbeddingReady(): Promise<boolean | undefined> {
  return fetch(`${CORE_URL}/embedding-ready`)
    .then(r => r.json())
    .then((data: { embeddingReady: boolean }) => data.embeddingReady)
    .catch(() => undefined)
}

async function fetchAvatarUrl(characterId: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const res = await fetch(`${CORE_URL}/characters/${encodeURIComponent(characterId)}/manifest.json`, { signal })
    if (!res.ok) return undefined

    const manifest: { avatar?: string } = await res.json()
    if (!manifest.avatar) return undefined

    return `${CORE_URL}/characters/${encodeURIComponent(characterId)}/${encodeURIComponent(manifest.avatar)}`
  } catch {
    return undefined
  }
}

async function fetchUserAvatarUrl(characterId: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const res = await fetch(`${CORE_URL}/characters/${encodeURIComponent(characterId)}/manifest.json`, { signal })
    if (!res.ok) return undefined

    const manifest: { userAvatar?: string } = await res.json()
    if (!manifest.userAvatar) return undefined

    return `${CORE_URL}/characters/${encodeURIComponent(characterId)}/${encodeURIComponent(manifest.userAvatar)}`
  } catch {
    return undefined
  }
}

export function ChatWindow() {
  const hasFetched = useRef(false)
  const [messages, setMessages] = useState<MessageData[]>([])
  const [isReplying, setIsReplying] = useState(false)
  const [appState, setAppState] = useState<AppState | null>(null)
  const prefersDark = usePrefersDark()
  const [embeddingReady, setEmbeddingReady] = useState<boolean>(false)
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
  const hasCompletedInitialWarmupRef = useRef(false)

  useEffect(() => {
    appStateRef.current = appState
  }, [appState])

  useEffect(() => {
    if (hasFetched.current) return
    hasFetched.current = true

    fetch(`${CORE_URL}/state`)
      .then(r => r.json())
      .then((state: AppState) => {
        if (sessionSyncControllerRef.current) return
        const controller = new AbortController()
        sessionSyncControllerRef.current = controller

        setAppState(state)
        setEmbeddingReady(state.embeddingReady)
        setWallpaperUrl(wallpaperUrlFor(state.presetSnapshot))
        if (state.presetSnapshot?.characterId) {
          fetchAvatarUrl(state.presetSnapshot.characterId, controller.signal).then(url => {
            if (controller.signal.aborted) return
            setAvatarUrl(url)
          })
          fetchUserAvatarUrl(state.presetSnapshot.characterId, controller.signal).then(url => {
            if (controller.signal.aborted) return
            setUserAvatarUrl(url)
          })
        }
        if (state.sessionId) {
          loadInitialMessages(state.sessionId, controller.signal)
        }
      })
      .catch(() => {
        addSystemMessage('无法连接核心服务，请确认服务已启动', true)
      })
  }, [])

  useEffect(() => {
    if (embeddingReady) {
      hasCompletedInitialWarmupRef.current = true
      return
    }
    if (hasCompletedInitialWarmupRef.current) return

    const interval = setInterval(() => {
      fetchEmbeddingReady().then(ready => {
        if (ready !== undefined) setEmbeddingReady(ready)
      })
    }, 3000)

    return () => clearInterval(interval)
  }, [embeddingReady])

  useEffect(() => {
    const syncSessionOnFocus = async () => {
      try {
        const response = await fetch(`${CORE_URL}/state`)
        const state: AppState = await response.json()

        setAppState(state)
        setWallpaperUrl(wallpaperUrlFor(state.presetSnapshot))

        if (state.sessionId === appStateRef.current?.sessionId) return

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
        if (state.sessionId) {
          loadInitialMessages(state.sessionId, controller.signal)
        }

        const nextAvatarUrl = state.presetSnapshot?.characterId
          ? await fetchAvatarUrl(state.presetSnapshot.characterId, controller.signal)
          : undefined
        const nextUserAvatarUrl = state.presetSnapshot?.characterId
          ? await fetchUserAvatarUrl(state.presetSnapshot.characterId, controller.signal)
          : undefined
        if (controller.signal.aborted) return
        setAvatarUrl(nextAvatarUrl)
        setUserAvatarUrl(nextUserAvatarUrl)
      } catch {
      }
    }

    const handler = () => {
      fetchEmbeddingReady().then(ready => {
        if (ready !== undefined) setEmbeddingReady(ready)
      })
      syncSessionOnFocus()
    }
    window.addEventListener('focus', handler)

    const watchdog = createWatchdogEventSource({
      url: `${CORE_URL}/events`,
      listeners: {
        'preset-switched': () => {
          syncSessionOnFocus()
        },
      },
      onOpen: () => {
        syncSessionOnFocus()
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

  async function loadInitialMessages(sessionId: string, signal: AbortSignal) {
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
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      addSystemMessage('加载历史消息失败', true)
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
        addSystemMessage('加载历史消息失败', true)
      }
    } finally {
      isLoadingMoreRef.current = false
    }
  }

  function addSystemMessage(content: string, isError = false) {
    setMessages(prev => [...prev, {
      id: Date.now().toString(),
      role: 'system' as const,
      content,
      createdAt: Date.now(),
      isError,
    }])
  }

  const sendMessage = useCallback(async (text: string) => {
    if (activeControllersRef.current.size === 0) {
      fetchEmbeddingReady().then(ready => {
        if (ready !== undefined) setEmbeddingReady(ready)
      })
    }

    setMessages(prev => [...prev, {
      id: Date.now().toString(),
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
          const { text: replyText, sessionId: replySessionId } = data as { messageId: string; text: string; sessionId: string }
          if (replySessionId !== appStateRef.current?.sessionId) continue
          setMessages(prev => [...prev, {
            id: Date.now().toString(),
            role: 'assistant' as const,
            content: replyText,
            createdAt: Date.now(),
          }])
        }

        if (event === 'system') {
          const { payload, sessionId: replySessionId } = data as { type: string; payload: { message: string }; sessionId: string }
          if (replySessionId !== appStateRef.current?.sessionId) continue
          addSystemMessage(payload.message, true)
        }

      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        addSystemMessage('回复失败，请稍后重试', true)
      }
    } finally {
      activeControllersRef.current.delete(controller)
      setIsReplying(false)
    }
  }, [])

  const displayName = appState?.presetSnapshot?.name ?? '角色'

  return (
    <div
      className={`chat-window${embeddingReady ? '' : ' chat-window--embedding-not-ready'}`}
      style={wallpaperUrl ? { backgroundImage: `url(${wallpaperUrl})` } : undefined}
    >
      <TitleBar avatarUrl={avatarUrl} displayName={displayName} />

      {appState?.ollamaReady === false && (
        <div className="banner banner--warn">
          Ollama 未运行，请先启动 Ollama
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
        <InputBar onSend={sendMessage} />
      </div>
    </div>
  )
}
