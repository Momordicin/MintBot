import React, { useCallback, useEffect, useRef, useState } from 'react'

import { CORE_URL } from '../../coreUrl.js'
const PAGE_SIZE = 20

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

const ROLE_LABELS: Record<HistoryMessage['role'], string> = {
  user: '用户',
  assistant: '助手',
  system: '系统',
}

interface MessageBrowserProps {
  sessionId: string
}

export function MessageBrowser({ sessionId }: MessageBrowserProps) {
  const [messages, setMessages] = useState<HistoryMessage[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  const loadInitial = useCallback((sid: string) => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setIsLoading(true)
    setError(null)

    fetch(`${CORE_URL}/messages?sessionId=${encodeURIComponent(sid)}&limit=${PAGE_SIZE}`, { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((page: MessagesPageResponse) => {
        setMessages(page.messages)
        setHasMore(page.hasMore)
      })
      .catch(err => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError('加载消息失败')
      })
      .finally(() => {
        if (controller.signal.aborted) return
        setIsLoading(false)
      })
  }, [])

  useEffect(() => {
    setMessages([])
    setHasMore(false)
    setError(null)
    loadInitial(sessionId)
    return () => controllerRef.current?.abort()
  }, [sessionId, loadInitial])

  const loadMore = useCallback(async () => {
    if (!hasMore || isLoadingMore || messages.length === 0) return
    const beforeId = messages[0].id
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setIsLoadingMore(true)
    setError(null)
    try {
      const response = await fetch(
        `${CORE_URL}/messages?sessionId=${encodeURIComponent(sessionId)}&limit=${PAGE_SIZE}&beforeId=${beforeId}`,
        { signal: controller.signal }
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const page: MessagesPageResponse = await response.json()
      if (controller.signal.aborted) return
      setMessages(prev => [...page.messages, ...prev])
      setHasMore(page.hasMore)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setError('加载更早消息失败')
    } finally {
      if (!controller.signal.aborted) setIsLoadingMore(false)
    }
  }, [sessionId, hasMore, isLoadingMore, messages])

  return (
    <div className="memory-list">
      {error && (
        <div className="character-panel__error">
          {error}{' '}
          <button className="memory-btn" onClick={() => loadInitial(sessionId)}>重试</button>
        </div>
      )}
      {isLoading && <div className="memory-loading">加载中…</div>}
      {!isLoading && !error && (
        <>
          {hasMore && (
            <button className="memory-btn" onClick={loadMore} disabled={isLoadingMore}>
              {isLoadingMore ? '加载中…' : '加载更早消息'}
            </button>
          )}
          {messages.map(m => (
            <div key={m.id} className="memory-list-row">
              <div className="memory-list-row__meta">
                <span>{ROLE_LABELS[m.role]}</span>
                <span>{new Date(m.createdAt).toLocaleString()}</span>
              </div>
              <div className="memory-list-row__content">{m.content}</div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
