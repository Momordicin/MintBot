import React, { useCallback, useEffect, useRef, useState } from 'react'
import { MessageList } from './MessageList'
import { InputBar } from './InputBar'
import { MessageData } from './MessageBubble'
import { parseSSE } from './sse'
import './chat.css'

const CORE_URL = 'http://127.0.0.1:3000'
const DEFAULT_WALLPAPER_URL = `${CORE_URL}/wallpapers/bg.jpg`

interface PresetSnapshot {
  presetId: string
  name: string
  characterId: string
  modelType: string
  modelName: string
  wallpaperPath?: string
  systemPrompt: string
}

interface AppState {
  sessionId: string | null
  presetSnapshot: PresetSnapshot | null
  ollamaReady: boolean | null
  emotion: null
  embeddingQueue: null
}

interface PresetOption {
  presetId: string
  name: string
}

function wallpaperUrlFor(snapshot: PresetSnapshot | null): string {
  return snapshot?.wallpaperPath
    ? `${CORE_URL}/wallpapers/${encodeURIComponent(snapshot.wallpaperPath)}`
    : DEFAULT_WALLPAPER_URL
}

export function ChatWindow() {
  const hasFetched = useRef(false)
  const [messages, setMessages] = useState<MessageData[]>([])
  const [isReplying, setIsReplying] = useState(false)
  const [appState, setAppState] = useState<AppState | null>(null)
  const [wallpaperUrl, setWallpaperUrl] = useState<string | null>(null)
  const [presets, setPresets] = useState<PresetOption[]>([])
  // 回复进行中用户仍可继续发送新消息，同一时间可能有多个 /chat 请求在途，
  // 用 Set 而不是单一 ref，保证切换 preset 时能把所有仍在进行中的请求都中断掉
  const activeControllersRef = useRef<Set<AbortController>>(new Set())

  useEffect(() => {
    if (hasFetched.current) return
    hasFetched.current = true

    fetch(`${CORE_URL}/state`)
      .then(r => r.json())
      .then((state: AppState) => {
        setAppState(state)
        setWallpaperUrl(wallpaperUrlFor(state.presetSnapshot))
      })
      .catch(() => {
        addSystemMessage('无法连接核心服务，请确认服务已启动', true)
      })

    fetch(`${CORE_URL}/presets`)
      .then(r => r.json())
      .then((list: PresetOption[]) => setPresets(list))
      .catch(() => {
        // preset 列表拉取失败不影响主聊天流程，静默忽略即可
      })
  }, [])

  const switchPreset = useCallback(async (presetId: string) => {
    // 切换时中断所有仍在进行中的 /chat 请求（不止"最新一次"——回复进行中用户仍可继续发送
    // 新消息，可能同时有多个在途请求），避免任意一个旧请求的 SSE 流继续把 message_done
    // 推回来，追加到已经切换过去的新 preset 对话框里
    for (const controller of activeControllersRef.current) {
      controller.abort()
    }
    setIsReplying(false)

    try {
      const response = await fetch(`${CORE_URL}/switch-preset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ presetId }),
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const state: AppState = await response.json()
      setAppState(state)
      setWallpaperUrl(wallpaperUrlFor(state.presetSnapshot))
      setMessages([])
    } catch {
      addSystemMessage('切换角色失败，请稍后重试', true)
    }
  }, [])

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
        // abort() 只能拒绝掉"还没读完"的 reader.read()——如果完整的 SSE 事件已经读进了
        // parseSSE 生成器的本地缓冲区，只是这个循环还没来得及处理，abort 本身拦不住。
        // 这里显式检查 signal 状态，避免把过期的 message_done/system 事件应用到已经
        // 切换过去的新 preset 界面上
        if (controller.signal.aborted) break

        if (event === 'message_done') {
          const { text: replyText } = data as { messageId: string; text: string }
          setMessages(prev => [...prev, {
            id: Date.now().toString(),
            role: 'assistant' as const,
            content: replyText,
            createdAt: Date.now(),
          }])
        }

        if (event === 'system') {
          const { payload } = data as { type: string; payload: { message: string } }
          addSystemMessage(payload.message, true)
        }

        // emotion: Phase 2 处理
        // message_chunk: Phase 4 开放后处理
      }
    } catch (err) {
      // AbortError 是切换 preset 主动中断导致的，不算回复失败，不展示错误气泡
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
      className="chat-window"
      style={wallpaperUrl ? { backgroundImage: `url(${wallpaperUrl})` } : undefined}
    >
      {appState?.ollamaReady === false && (
        <div className="banner banner--warn">
          Ollama 未运行，请先启动 Ollama
        </div>
      )}

      {presets.length > 0 && (
        <div className="preset-switcher">
          <select
            value={appState?.presetSnapshot?.presetId ?? ''}
            onChange={e => switchPreset(e.target.value)}
          >
            {presets.map(p => (
              <option key={p.presetId} value={p.presetId}>{p.name}</option>
            ))}
          </select>
        </div>
      )}

      <div className="chat-area">
        <MessageList
          messages={messages}
          isReplying={isReplying}
          displayName={displayName}
        />
      </div>

      <div className="input-area">
        <InputBar onSend={sendMessage} />
      </div>
    </div>
  )
}
