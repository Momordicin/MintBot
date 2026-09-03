import React, { useCallback, useEffect, useRef, useState } from 'react'
import './settings.css'

const CORE_URL = 'http://127.0.0.1:3000'

// GET/PATCH /config/window-behavior 的响应类型：本地重复定义，不从 services/core 反向
// 导入路由文件里的类型——同 ModelConfigPanel 里 ModelConfigSummary 的既有约定
interface WindowBehaviorConfig {
  pinMode: 'off' | 'dodge-fullscreen' | 'always-on-top'
  fullscreenWhitelist: string[]
  blacklist: string[]
}

// 全局单例配置面板：不存在"切换 preset 导致响应姗姗来迟"的竞态，同 ModelConfigPanel 的
// AbortController 用法，只需要在卸载时 abort 在途的 PATCH
export function WindowBehaviorPanel() {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [config, setConfig] = useState<WindowBehaviorConfig | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const patchControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => {
      patchControllerRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    fetch(`${CORE_URL}/config/window-behavior`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data: WindowBehaviorConfig) => setConfig(data))
      .catch(() => setLoadError('加载窗口行为配置失败，请稍后重试'))
      .finally(() => setLoading(false))
  }, [])

  // 托盘菜单也能直接改这份配置（见 electron/main/windowBehavior.ts），设置页开着的时候
  // 要能实时感知到——跟 src/chat/ChatWindow.tsx / src/overlay/OverlayApp.tsx 订阅
  // GET /events 的既有模式一致，不用轮询
  useEffect(() => {
    const source = new EventSource(`${CORE_URL}/events`)
    source.addEventListener('window-behavior-changed', (event: MessageEvent) => {
      try {
        setConfig(JSON.parse(event.data))
      } catch {
        // 广播帧解析失败不影响面板已有的展示，等下一次改动再重新同步即可
      }
    })
    return () => {
      source.close()
    }
  }, [])

  const patchConfig = useCallback(async (partial: Partial<WindowBehaviorConfig>) => {
    patchControllerRef.current?.abort()
    const controller = new AbortController()
    patchControllerRef.current = controller
    setErrorMessage(null)

    try {
      const response = await fetch(`${CORE_URL}/config/window-behavior`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
        signal: controller.signal,
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`)
      }

      const data: WindowBehaviorConfig = await response.json()
      if (controller.signal.aborted) return
      setConfig(data)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setErrorMessage(err instanceof Error ? err.message : '保存窗口行为配置失败，请稍后重试')
    }
  }, [])

  const handlePinModeChange = useCallback((pinMode: WindowBehaviorConfig['pinMode']) => {
    patchConfig({ pinMode })
  }, [patchConfig])

  const handleAddToList = useCallback(async (field: 'fullscreenWhitelist' | 'blacklist') => {
    if (!config) return
    const result = await window.electronAPI.selectExeFile()
    if (!result) return // 用户取消选择，不算失败

    // 去重：已存在则不重复添加
    if (config[field].includes(result.filename)) return
    patchConfig({ [field]: [...config[field], result.filename] })
  }, [config, patchConfig])

  const handleRemoveFromList = useCallback((field: 'fullscreenWhitelist' | 'blacklist', entry: string) => {
    if (!config) return
    patchConfig({ [field]: config[field].filter(item => item !== entry) })
  }, [config, patchConfig])

  if (loading) {
    return <div className="memory-loading">加载中…</div>
  }

  if (loadError || !config) {
    return <div className="character-panel__error">{loadError ?? '加载窗口行为配置失败，请稍后重试'}</div>
  }

  return (
    <div className="window-behavior-panel">
      <div className="window-behavior-panel__section">
        <div className="window-behavior-panel__section-label">聊天窗口置顶</div>
        <div className="character-panel__row">
          <select
            value={config.pinMode}
            onChange={e => handlePinModeChange(e.target.value as WindowBehaviorConfig['pinMode'])}
          >
            <option value="off">关闭</option>
            <option value="dodge-fullscreen">全屏时跳非全屏屏幕置顶</option>
            <option value="always-on-top">绝对置顶</option>
          </select>
        </div>
      </div>

      <WindowBehaviorList
        title="全屏白名单"
        hint="这些程序全屏时，悬浮窗仍显示在最上层"
        entries={config.fullscreenWhitelist}
        onAdd={() => handleAddToList('fullscreenWhitelist')}
        onRemove={entry => handleRemoveFromList('fullscreenWhitelist', entry)}
      />

      <WindowBehaviorList
        title="黑名单"
        hint="这些程序即使不全屏，悬浮窗也不会盖在它上面"
        entries={config.blacklist}
        onAdd={() => handleAddToList('blacklist')}
        onRemove={entry => handleRemoveFromList('blacklist', entry)}
      />

      {errorMessage && <div className="character-panel__error">{errorMessage}</div>}
    </div>
  )
}

interface WindowBehaviorListProps {
  title: string
  hint: string
  entries: string[]
  onAdd: () => void
  onRemove: (entry: string) => void
}

function WindowBehaviorList({ title, hint, entries, onAdd, onRemove }: WindowBehaviorListProps) {
  return (
    <div className="window-behavior-panel__section">
      <div className="window-behavior-panel__section-label">{title}</div>
      <div className="character-panel__hint">{hint}</div>
      <div className="memory-list">
        {entries.length === 0 && <div className="memory-empty">暂无</div>}
        {entries.map(entry => (
          <div key={entry} className="window-behavior-panel__list-row">
            <span>{entry}</span>
            <button className="memory-btn memory-btn--danger" onClick={() => onRemove(entry)}>删除</button>
          </div>
        ))}
      </div>
      <button className="memory-btn" onClick={onAdd}>添加</button>
    </div>
  )
}
