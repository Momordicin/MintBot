// src/settings/ApiKeyField.tsx — 设置窗口共用的 API Key 字段
// 用法：ModelConfigPanel 的三个 Key 分组与 PersonaModelPanel 的角色模型覆盖区渲染 <ApiKeyField />；导出 KeyProvider / ENV_VAR
// 对应文件：src/settings/ModelConfigPanel.tsx / src/settings/PersonaModelPanel.tsx / src/settings/settings.css
import React from 'react'

export type KeyProvider = 'anthropic' | 'openai' | 'deepseek'

export const ENV_VAR: Record<KeyProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
}

export type ApiKeyLoadStatus = 'loading' | 'ready' | 'error'

export interface ApiKeySummary {
  hasKey: boolean
  last4: string | null
}

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

interface ApiKeyFieldProps {
  summary: ApiKeySummary
  envDetected: boolean
  envVar: string
  fromEnv: boolean
  keyInput: string
  editing: boolean
  onKeyInputChange: (value: string) => void
  onEditingChange: (editing: boolean) => void
  onFromEnvChange: (checked: boolean) => void
  keyStatus?: ApiKeyLoadStatus
  envStatus?: ApiKeyLoadStatus
}

export function ApiKeyField({ summary, envDetected, envVar, fromEnv, keyInput, editing, onKeyInputChange, onEditingChange, onFromEnvChange, keyStatus = 'ready', envStatus = 'ready' }: ApiKeyFieldProps) {
  const maskedValue = summary.hasKey ? `••••••••${summary.last4 ?? ''}` : '未填写'
  const keyReady = keyStatus === 'ready'
  const pending = !keyReady || envStatus !== 'ready'
  return (
    <>
      <div className="model-config-panel__field">
        <label>API Key</label>
        <div className="model-config-panel__secret">
          {!keyReady ? (
            <input key="view" type="text" readOnly value={keyStatus === 'loading' ? '加载中…' : '读取失败'} />
          ) : fromEnv ? (
            <input key="view" type="text" readOnly value={`使用环境变量 ${envVar}`} />
          ) : editing ? (
            <input
              key="edit"
              type="password"
              autoFocus
              autoComplete="new-password"
              spellCheck={false}
              value={keyInput}
              placeholder="输入新的 API Key"
              onChange={e => onKeyInputChange(e.target.value)}
            />
          ) : (
            <input key="view" type="text" readOnly value={maskedValue} />
          )}
          {keyReady && !fromEnv && (
            <button
              type="button"
              className="model-config-panel__icon-btn"
              aria-label={editing ? '取消编辑' : '编辑 API Key'}
              onClick={() => {
                onKeyInputChange('')
                onEditingChange(!editing)
              }}
            >
              {editing ? <CloseIcon /> : <PencilIcon />}
            </button>
          )}
        </div>
      </div>
      <label className="model-config-panel__checkbox">
        <input
          type="checkbox"
          checked={fromEnv}
          disabled={pending || (!envDetected && !fromEnv)}
          onChange={e => onFromEnvChange(e.target.checked)}
        />
        自动配置 API Key（使用环境变量 {envVar}）
      </label>
      {envStatus === 'loading' && (
        <div className="model-config-panel__checkbox">正在检测环境变量 {envVar}…</div>
      )}
      {envStatus === 'ready' && !envDetected && (
        <div className="model-config-panel__checkbox">未检测到环境变量 {envVar}；修改环境变量后需重启 MintBot</div>
      )}
    </>
  )
}
