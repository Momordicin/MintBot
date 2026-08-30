import React, { useCallback, useEffect, useRef, useState } from 'react'

const CORE_URL = 'http://127.0.0.1:3000'
const PAGE_SIZE = 20

// GET /messages 返回的历史消息 shape，渲染层按自己的展示需要本地重复定义，
// 不引入 shared/types 依赖（同 ChatWindow.tsx 里 HistoryMessage 的约定）
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
  // sessionId 切换时中断上一个 session 仍在途的初始加载请求，避免它晚到后把
  // 已经属于新 session 的空列表状态覆盖掉
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
    // 和 loadInitial 共用同一个 controllerRef：sessionId 切换时 useEffect 的 cleanup 会
    // abort 它，避免这次"加载更多"晚于切换才返回，把旧 session 的消息错误地 prepend 进新
    // session 已经加载好的列表里
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
