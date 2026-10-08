import React, { useCallback, useEffect, useRef, useState } from 'react'

import { CORE_URL } from '../../coreUrl.js'
const PAGE_SIZE = 20

type EntityType = 'person' | 'event' | 'preference' | 'place' | 'other'

interface EntityRow {
  id: number
  type: EntityType
  value: string
  validFrom: number
}

interface EntitiesPageResponse {
  entities: EntityRow[]
  hasMore: boolean
}

const TYPE_LABELS: Record<EntityType, string> = {
  person: '人物',
  event: '事件',
  preference: '偏好',
  place: '地点',
  other: '其他',
}

interface EntityListProps {
  sessionId: string
}

export function EntityList({ sessionId }: EntityListProps) {
  const [type, setType] = useState<EntityType | ''>('')
  const [entities, setEntities] = useState<EntityRow[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  const loadInitial = useCallback((sid: string, filterType: EntityType | '') => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setIsLoading(true)
    setError(null)

    const typeParam = filterType ? `&type=${filterType}` : ''
    fetch(`${CORE_URL}/entities?sessionId=${encodeURIComponent(sid)}&limit=${PAGE_SIZE}${typeParam}`, { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((page: EntitiesPageResponse) => {
        setEntities(page.entities)
        setHasMore(page.hasMore)
      })
      .catch(err => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError('加载实体失败')
      })
      .finally(() => {
        if (controller.signal.aborted) return
        setIsLoading(false)
      })
  }, [])

  useEffect(() => {
    setEntities([])
    setHasMore(false)
    setError(null)
    loadInitial(sessionId, type)
    return () => controllerRef.current?.abort()
  }, [sessionId, type, loadInitial])

  const loadMore = useCallback(async () => {
    if (!hasMore || isLoadingMore || entities.length === 0) return
    const beforeId = entities[0].id
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setIsLoadingMore(true)
    setError(null)
    try {
      const typeParam = type ? `&type=${type}` : ''
      const response = await fetch(
        `${CORE_URL}/entities?sessionId=${encodeURIComponent(sessionId)}&limit=${PAGE_SIZE}&beforeId=${beforeId}${typeParam}`,
        { signal: controller.signal }
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const page: EntitiesPageResponse = await response.json()
      if (controller.signal.aborted) return
      setEntities(prev => [...page.entities, ...prev])
      setHasMore(page.hasMore)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setError('加载更多实体失败')
    } finally {
      if (!controller.signal.aborted) setIsLoadingMore(false)
    }
  }, [sessionId, type, hasMore, isLoadingMore, entities])

  return (
    <div className="memory-list">
      <div className="memory-toolbar">
        <select value={type} onChange={e => setType(e.target.value as EntityType | '')}>
          <option value="">全部</option>
          {Object.entries(TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      {error && (
        <div className="character-panel__error">
          {error}{' '}
          <button className="memory-btn" onClick={() => loadInitial(sessionId, type)}>重试</button>
        </div>
      )}
      {isLoading && <div className="memory-loading">加载中…</div>}
      {!isLoading && !error && (
        <>
          {entities.map(e => (
            <div key={e.id} className="memory-list-row">
              <div className="memory-list-row__meta">
                <span>{TYPE_LABELS[e.type]}</span>
                <span>{new Date(e.validFrom).toLocaleDateString()}</span>
              </div>
              <div className="memory-list-row__content">{e.value}</div>
            </div>
          ))}
          {hasMore && (
            <button className="memory-btn" onClick={loadMore} disabled={isLoadingMore}>
              {isLoadingMore ? '加载中…' : '加载更多'}
            </button>
          )}
        </>
      )}
    </div>
  )
}
