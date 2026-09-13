import React, { useCallback, useEffect, useRef, useState } from 'react'
import './settings.css'

const CORE_URL = 'http://127.0.0.1:3000'

// GET/PATCH /config/window-behavior 的响应类型：本地重复定义，不从 services/core 反向
// 导入路由文件里的类型——同 ModelConfigPanel 里 ModelConfigSummary 的既有约定
type ChatPinMode = 'always' | 'smart' | 'off'
type AppRuleEffect = 'allow' | 'soft' | 'hard'

interface AppRule {
  exeName: string
  effect: AppRuleEffect
}

interface WindowBehaviorConfig {
  chatPinMode: ChatPinMode
  petAvoidanceEnabled: boolean
  appRules: AppRule[]
}

const CHAT_PIN_MODE_OPTIONS: ReadonlyArray<{ value: ChatPinMode; label: string }> = [
  { value: 'always', label: '始终置顶' },
  { value: 'smart', label: '智能置顶' },
  { value: 'off', label: '不置顶' },
]

const APP_RULE_EFFECT_OPTIONS: ReadonlyArray<{ value: AppRuleEffect; label: string }> = [
  { value: 'allow', label: '不避让' },
  { value: 'soft', label: '轻度避让' },
  { value: 'hard', label: '完全隐藏' },
]

// 全局单例配置面板：不存在"切换 preset 导致响应姗姗来迟"的竞态，同 ModelConfigPanel 的
// AbortController 用法，只需要在卸载时 abort 在途的 PATCH
export function WindowBehaviorPanel() {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [config, setConfig] = useState<WindowBehaviorConfig | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const patchControllerRef = useRef<AbortController | null>(null)

  // 「最新意图」的同步副本，与 config 始终一起更新（只经 applyConfig 一个写入口）。
  //
  // 三个 appRules 处理函数必须读它、不能读 config：PATCH 传的是整份 appRules 数组，服务端对这个
  // 字段是整体替换、不做逐条合并，而 setConfig 是异步的——连续两次编辑时，第二次的闭包还看不到
  // 第一次的结果，算出的数组会把它丢掉。ref 在发出 PATCH 的同一刻就更新，连续编辑因此总是叠加；
  // 这也是"中止上一个在途 PATCH"安全的原因：被中止那次的内容已整份包含在新的这一次里
  const configRef = useRef<WindowBehaviorConfig | null>(null)

  const applyConfig = useCallback((next: WindowBehaviorConfig) => {
    configRef.current = next
    setConfig(next)
  }, [])

  useEffect(() => {
    return () => {
      patchControllerRef.current?.abort()
    }
  }, [])

  const fetchConfig = useCallback(async () => {
    const response = await fetch(`${CORE_URL}/config/window-behavior`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return (await response.json()) as WindowBehaviorConfig
  }, [])

  useEffect(() => {
    fetchConfig()
      .then(applyConfig)
      .catch(() => setLoadError('加载窗口行为配置失败，请稍后重试'))
      .finally(() => setLoading(false))
  }, [fetchConfig, applyConfig])

  // 托盘菜单也能直接改这份配置（见 electron/main/index.ts 的 rebuildTrayMenu），设置页开着的
  // 时候要能实时感知到——跟 src/chat/ChatWindow.tsx / src/overlay/OverlayApp.tsx 订阅
  // GET /events 的既有模式一致，不用轮询
  useEffect(() => {
    const source = new EventSource(`${CORE_URL}/events`)
    source.addEventListener('window-behavior-changed', (event: MessageEvent) => {
      try {
        applyConfig(JSON.parse(event.data))
      } catch {
        // 广播帧解析失败不影响面板已有的展示，等下一次改动再重新同步即可
      }
    })
    return () => {
      source.close()
    }
  }, [applyConfig])

  const patchConfig = useCallback(async (partial: Partial<WindowBehaviorConfig>) => {
    const base = configRef.current
    if (!base) return

    patchControllerRef.current?.abort()
    const controller = new AbortController()
    patchControllerRef.current = controller
    setErrorMessage(null)

    // 乐观更新：这次编辑立刻并进「最新意图」，下一次编辑才能在它之上继续叠加（见 configRef）
    applyConfig({ ...base, ...partial })

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
      applyConfig(data)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setErrorMessage(err instanceof Error ? err.message : '保存窗口行为配置失败，请稍后重试')

      // 上面的乐观更新已经写进界面，但这次写入并没有落到服务端——重新拉一次权威状态把它纠正
      // 回来。不回滚到 base：期间可能已经有别的编辑或托盘改动叠加上来，base 未必是正确的终点。
      // 只有这次请求仍是最新的一次才纠正——若已经有更新的 PATCH 在途，让它自己的响应去收敛，
      // 不要用一份更旧的服务端状态把更新的乐观状态盖回去
      if (patchControllerRef.current !== controller) return
      fetchConfig()
        .then(applyConfig)
        .catch(() => {
          // 连纠正都失败（服务没起来之类）：保留上面已经显示的错误信息，不再叠加第二条
        })
    }
  }, [applyConfig, fetchConfig])

  // 三个 appRules 处理函数一律读 configRef.current 而不是 config——它们都要基于"包含上一次
  // 编辑在内"的完整数组重新计算，理由见 configRef 定义处注释
  const handleAddRule = useCallback(async () => {
    const result = await window.electronAPI.selectExeFile()
    if (!result) return // 用户取消选择，不算失败

    // 在 await 之后才读 ref：文件选择对话框可能开着好一会儿，这期间托盘/SSE 或用户自己的
    // 其它操作都可能改过配置，要用的是这一刻的最新意图，不是点「添加」那一瞬间的快照
    const current = configRef.current
    if (!current) return

    // 去重：同名规则已存在则不重复添加。大小写不敏感——Windows 文件名本身不区分大小写，
    // 后端 updateWindowBehaviorConfig 也是按这个口径去重，两边保持一致
    const lower = result.filename.toLowerCase()
    if (current.appRules.some(rule => rule.exeName.toLowerCase() === lower)) return

    // 新规则默认 'soft'（避让但不彻底消失）
    patchConfig({ appRules: [...current.appRules, { exeName: result.filename, effect: 'soft' }] })
  }, [patchConfig])

  const handleRuleEffectChange = useCallback((exeName: string, effect: AppRuleEffect) => {
    const current = configRef.current
    if (!current) return
    patchConfig({ appRules: current.appRules.map(rule => (rule.exeName === exeName ? { ...rule, effect } : rule)) })
  }, [patchConfig])

  const handleRemoveRule = useCallback((exeName: string) => {
    const current = configRef.current
    if (!current) return
    patchConfig({ appRules: current.appRules.filter(rule => rule.exeName !== exeName) })
  }, [patchConfig])

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
        <div className="character-panel__hint">只影响聊天窗口，不影响桌宠。</div>
        {CHAT_PIN_MODE_OPTIONS.map(option => (
          <label key={option.value} className="window-behavior-panel__choice">
            <input
              type="radio"
              name="chat-pin-mode"
              value={option.value}
              checked={config.chatPinMode === option.value}
              onChange={() => patchConfig({ chatPinMode: option.value })}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>

      <div className="window-behavior-panel__section">
        <div className="window-behavior-panel__section-label">智能避让</div>
        <label className="window-behavior-panel__choice">
          <input
            type="checkbox"
            checked={config.petAvoidanceEnabled}
            onChange={e => patchConfig({ petAvoidanceEnabled: e.target.checked })}
          />
          <span>开启</span>
        </label>
        <div className="character-panel__hint">
          {config.petAvoidanceEnabled
            ? '桌宠会避让全屏或指定应用，必要时自动移动到其他屏幕、贴边或暂时隐藏。'
            : '桌宠保持悬浮，但不会再自动避让其他应用。'}
        </div>
      </div>

      <div className="window-behavior-panel__section">
        <div className="window-behavior-panel__section-label">应用规则</div>
        <div className="character-panel__hint">
          为单个程序指定避让方式。「不避让」表示即使它全屏，桌宠也照常显示。
        </div>
        <div className="memory-list">
          {config.appRules.length === 0 && <div className="memory-empty">暂无</div>}
          {config.appRules.map(rule => (
            <div key={rule.exeName} className="window-behavior-panel__list-row">
              <span>{rule.exeName}</span>
              <div className="window-behavior-panel__list-actions">
                <select
                  className="window-behavior-panel__select"
                  value={rule.effect}
                  onChange={e => handleRuleEffectChange(rule.exeName, e.target.value as AppRuleEffect)}
                >
                  {APP_RULE_EFFECT_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <button className="memory-btn memory-btn--danger" onClick={() => handleRemoveRule(rule.exeName)}>删除</button>
              </div>
            </div>
          ))}
        </div>
        <button className="memory-btn" onClick={handleAddRule}>添加</button>
      </div>

      {errorMessage && <div className="character-panel__error">{errorMessage}</div>}
    </div>
  )
}
