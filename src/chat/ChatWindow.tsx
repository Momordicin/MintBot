import React, { useCallback, useEffect, useState } from 'react'
import { MessageList } from './MessageList'
import { InputBar } from './InputBar'
import { MessageData } from './MessageBubble'
import { parseSSE } from './sse'
import './chat.css'

const CORE_URL = 'http://127.0.0.1:3000'

interface PresetSnapshot {
  presetId: string
  name: string
  characterId: string
  modelType: string
  modelName: string
  systemPrompt: string
}

interface AppState {
  sessionId: string | null
  presetSnapshot: PresetSnapshot | null
  ollamaReady: boolean | null
  emotion: null
  embeddingQueue: null
}

export function ChatWindow() {
  const [messages, setMessages] = useState<MessageData[]>([])
  const [isReplying, setIsReplying] = useState(false)
  const [appState, setAppState] = useState<AppState | null>(null)
  const [wallpaperUrl, setWallpaperUrl] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${CORE_URL}/state`)
      .then(r => r.json())
      .then((state: AppState) => {
        setAppState(state)
        setWallpaperUrl(`${CORE_URL}/wallpapers/bg.jpg`)
      })
      .catch(() => {
        addSystemMessage('无法连接核心服务，请确认服务已启动', true)
      })
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

    try {
      const response = await fetch(`${CORE_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      for await (const { event, data } of parseSSE(response)) {
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
    } catch {
      addSystemMessage('回复失败，请稍后重试', true)
    } finally {
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
