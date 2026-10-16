// src/settings/memory/SummaryList.tsx — "摘要列表"子面板：列出当前会话的全部摘要及其覆盖的消息范围
// 用法：MemoryPanel 渲染 <SummaryList sessionId />；GET /summaries?sessionId
// 对应文件：src/settings/memory/MemoryPanel.tsx / services/core/routes/memory.ts
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CORE_URL } from '../../coreUrl.js'

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
  const { t, i18n } = useTranslation()
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
        setError(i18n.t('加载摘要失败'))
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
          <button className="memory-btn" onClick={() => load(sessionId)}>{t('重试')}</button>
        </div>
      )}
      {isLoading && <div className="memory-loading">{t('加载中…')}</div>}
      {!isLoading && !error && summaries.length === 0 && (
        <div className="memory-empty">{t('暂无摘要')}</div>
      )}
      {!isLoading && !error && summaries.map(s => (
        <div key={s.id} className="memory-list-row">
          <div className="memory-list-row__content">{s.content}</div>
          <div className="memory-list-row__meta">
            <span>{t('消息 #{{from}}–#{{to}}', { from: s.fromMessageId, to: s.toMessageId })}</span>
            <span>{new Date(s.createdAt).toLocaleDateString(i18n.language)}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
