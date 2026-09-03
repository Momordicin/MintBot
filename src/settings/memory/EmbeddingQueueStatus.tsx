import React, { useCallback, useEffect, useRef, useState } from 'react'

const CORE_URL = 'http://127.0.0.1:3000'

// GET /embedding-queue-status 是全局统计，不接受 sessionId，本组件也不接收 sessionId prop
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
  // 切到别的二级 tab 时本组件会被卸载——请求还没返回就卸载的话，不能再对已经卸载的组件调用
  // setState
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
    // StrictMode 开发模式下会先跑一遍 effect 再立刻跑一次 cleanup、然后重新跑一遍 effect
    // （模拟卸载再重新挂载），必须在这里重新置回 true——否则第一次的 cleanup 把它设成
    // false 之后，真正生效的第二次 load() 请求也会被 if (mountedRef.current) 永久挡住，
    // isLoading 从此再也没有机会被置回 false，表现成"一直在加载中"
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
