// src/settings/memory/EmbeddingQueueStatus.tsx — "Embedding 状态"子面板：显示全局 embedding 待处理队列统计，有激活角色时附带该角色的排队情况
// 用法：MemoryPanel 渲染 <EmbeddingQueueStatusView />（无 props，不依赖 sessionId）；挂载时与点击刷新时 GET /embedding-queue-status
// 对应文件：src/settings/memory/MemoryPanel.tsx / services/core/routes/memory.ts
import React, { useCallback, useEffect, useRef, useState } from 'react'

import { CORE_URL } from '../../coreUrl.js'

interface EmbeddingQueueStatusData {
  pendingCount: number
  oldestPendingAge: number
  oldestUnsummarizedAge: number
  activeConversation: boolean
  lastEmbeddingRun: number
  activePresetPendingCount: number | null
  activePresetOldestPendingAge: number | null
  pendingAheadOfActivePreset: number | null
}

export function EmbeddingQueueStatusView() {
  const [status, setStatus] = useState<EmbeddingQueueStatusData | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  const load = useCallback(() => {
    setIsLoading(true)
    setError(null)
    fetch(`${CORE_URL}/embedding-queue-status`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data: EmbeddingQueueStatusData) => {
        if (mountedRef.current) setStatus(data)
      })
      .catch(() => {
        if (mountedRef.current) setError('加载状态失败')
      })
      .finally(() => {
        if (mountedRef.current) setIsLoading(false)
      })
  }, [])

  useEffect(() => {
    mountedRef.current = true
    load()
    return () => {
      mountedRef.current = false
    }
  }, [load])

  return (
    <div className="memory-list">
      <div className="memory-note">以下为全局统计；若有激活角色，额外显示该角色自身的排队情况</div>

      {error && (
        <div className="character-panel__error">
          {error}{' '}
          <button className="memory-btn" onClick={load}>重试</button>
        </div>
      )}
      {isLoading && <div className="memory-loading">加载中…</div>}
      {!isLoading && !error && status && (
        <div className="memory-list-row">
          <div>待处理消息数：{status.pendingCount}</div>
          <div>最早待处理消息等待时间：{status.oldestPendingAge.toFixed(1)} 分钟</div>
          <div>最早未摘要消息等待时间：{status.oldestUnsummarizedAge.toFixed(1)} 天</div>
          <div>近期是否有活跃对话：{status.activeConversation ? '是' : '否'}</div>
          <div>
            上次 embedding 批处理时间：
            {status.lastEmbeddingRun ? new Date(status.lastEmbeddingRun).toLocaleString() : '从未运行过'}
          </div>
          {status.activePresetPendingCount !== null && (
            <>
              <div>当前角色待处理：{status.activePresetPendingCount} 条（前面还有 {status.pendingAheadOfActivePreset} 条待处理）</div>
              <div>当前角色最早待处理等待时间：{status.activePresetOldestPendingAge?.toFixed(1)} 分钟</div>
            </>
          )}
        </div>
      )}

      <button className="memory-btn" onClick={load} disabled={isLoading}>刷新</button>
    </div>
  )
}
