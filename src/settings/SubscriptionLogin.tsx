// src/settings/SubscriptionLogin.tsx — "订阅登录"区块：Claude Code / Codex 各一行的登录与重新登录按钮
// 用法：ModelConfigPanel 渲染 <SubscriptionLogin />（无 props）；GET /agents/status、POST /agents/:provider/login
// 对应文件：src/settings/ModelConfigPanel.tsx / services/core/routes/agents.ts
import React, { useEffect, useRef, useState } from 'react'
import './settings.css'

import { CORE_URL } from '../coreUrl.js'

type AgentProvider = 'claude-code' | 'codex'

interface AgentStatus {
  claudeCode: { loggedIn: boolean }
  codex: { loggedIn: boolean }
}

const ROWS: readonly { provider: AgentProvider; label: string }[] = [
  { provider: 'claude-code', label: 'Claude Code' },
  { provider: 'codex', label: 'Codex' },
]

export function SubscriptionLogin() {
  const [loggedIn, setLoggedIn] = useState<Record<AgentProvider, boolean | null>>({ 'claude-code': null, codex: null })
  const [busy, setBusy] = useState<Record<AgentProvider, boolean>>({ 'claude-code': false, codex: false })
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<AgentProvider, string | null>>({ 'claude-code': null, codex: null })
  const loginControllersRef = useRef<Set<AbortController>>(new Set())

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${CORE_URL}/agents/status`, { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data: AgentStatus) => {
        setLoggedIn({ 'claude-code': data.claudeCode.loggedIn, codex: data.codex.loggedIn })
      })
      .catch(err => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setLoggedIn({ 'claude-code': false, codex: false })
        setErrorMessage('加载订阅登录状态失败，请稍后重试')
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controllers = loginControllersRef.current
    return () => {
      controllers.forEach(controller => controller.abort())
    }
  }, [])

  const startLogin = async (provider: AgentProvider) => {
    const controller = new AbortController()
    loginControllersRef.current.add(controller)
    setBusy(prev => ({ ...prev, [provider]: true }))
    setRowErrors(prev => ({ ...prev, [provider]: null }))
    try {
      const response = await fetch(`${CORE_URL}/agents/${provider}/login`, { method: 'POST', signal: controller.signal })
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`)
      }
      const data: { loggedIn: boolean } = await response.json()
      setLoggedIn(prev => ({ ...prev, [provider]: data.loggedIn }))
      if (!data.loggedIn) setRowErrors(prev => ({ ...prev, [provider]: '未检测到登录，请确认命令行已安装并完成登录' }))
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setRowErrors(prev => ({ ...prev, [provider]: err instanceof Error ? err.message : '登录失败，请稍后重试' }))
    } finally {
      loginControllersRef.current.delete(controller)
      if (!controller.signal.aborted) setBusy(prev => ({ ...prev, [provider]: false }))
    }
  }

  return (
    <div className="model-config-panel__section">
      <div className="model-config-panel__section-label">订阅登录</div>
      {ROWS.map(({ provider, label }) => {
        const status = loggedIn[provider]
        const isBusy = busy[provider]
        return (
          <React.Fragment key={provider}>
          <div className="model-config-panel__row">
            <span className="model-config-panel__row-label model-config-panel__row-label--wide">{label}</span>
            <button
              className="rename-btn"
              onClick={() => startLogin(provider)}
              disabled={status !== false || isBusy}
            >
              {isBusy ? '登录中…' : status === null ? '检测中…' : status ? '已配置' : '开始配置'}
            </button>
            <button
              className="rename-btn"
              onClick={() => startLogin(provider)}
              disabled={isBusy || status === null}
            >
              刷新
            </button>
          </div>
          {rowErrors[provider] && <div className="character-panel__error">{rowErrors[provider]}</div>}
          </React.Fragment>
        )
      })}
      {errorMessage && <div className="character-panel__error">{errorMessage}</div>}
    </div>
  )
}
