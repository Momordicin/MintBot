import React, { useCallback, useEffect, useRef, useState } from 'react'

const CORE_URL = 'http://127.0.0.1:3000'

// GET /summaries 一次性返回全部，不分页，本面板只取展示需要的字段
interface SummaryRow {
  id: number
  content: string
  fromMessageId: number
  toMessageId: number
  createdAt: number
}

interface SummaryListProps {
  sessionId: string
}

export function SummaryList({ sessionId }: SummaryListProps) {
  const [summaries, setSummaries] = useState<SummaryRow[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  const load = useCallback((sid: string) => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setIsLoading(true)
    setError(null)

    fetch(`${CORE_URL}/summaries?sessionId=${encodeURIComponent(sid)}`, { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((list: SummaryRow[]) => setSummaries(list))
      .catch(err => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError('加载摘要失败')
      })
      .finally(() => {
        if (controller.signal.aborted) return
        setIsLoading(false)
      })
  }, [])

  useEffect(() => {
    setSummaries([])
    setError(null)
    load(sessionId)
    return () => controllerRef.current?.abort()
  }, [sessionId, load])

  return (
    <div className="memory-list">
      {error && (
        <div className="character-panel__error">
          {error}{' '}
          <button className="memory-btn" onClick={() => load(sessionId)}>重试</button>
        </div>
      )}
      {isLoading && <div className="memory-loading">加载中…</div>}
      {!isLoading && !error && summaries.length === 0 && (
        <div className="memory-empty">暂无摘要</div>
      )}
      {!isLoading && !error && summaries.map(s => (
        <div key={s.id} className="memory-list-row">
          <div className="memory-list-row__content">{s.content}</div>
          <div className="memory-list-row__meta">
            <span>消息 #{s.fromMessageId}–#{s.toMessageId}</span>
            <span>{new Date(s.createdAt).toLocaleDateString()}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
