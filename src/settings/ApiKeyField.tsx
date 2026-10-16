// src/settings/ApiKeyField.tsx — 设置窗口共用的 API Key 字段
// 用法：ModelConfigPanel 的三个 Key 分组渲染 <ApiKeyField />，PersonaModelPanel 的模型行渲染 <ApiKeyField compact />；导出 KeyProvider / ENV_VAR
// 对应文件：src/settings/ModelConfigPanel.tsx / src/settings/PersonaModelPanel.tsx / src/settings/settings.css
import React from 'react'
import { useTranslation } from 'react-i18next'

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
  compact?: boolean
}

export function ApiKeyField({ summary, envDetected, envVar, fromEnv, keyInput, editing, onKeyInputChange, onEditingChange, onFromEnvChange, keyStatus = 'ready', envStatus = 'ready', compact = false }: ApiKeyFieldProps) {
  const { t } = useTranslation()
  const maskedValue = summary.hasKey ? `••••••••${summary.last4 ?? ''}` : t('未填写')
  const keyReady = keyStatus === 'ready'
  const pending = !keyReady || envStatus !== 'ready'
  const envLabel = t('自动配置 API Key（使用环境变量 {{envVar}}）', { envVar })
  const envHint = envStatus === 'ready' && !envDetected ? t('自动配置 API Key（使用环境变量 {{envVar}}）。未检测到环境变量 {{envVar}}；修改环境变量后需重启 MintBot', { envVar }) : envLabel
  return (
    <>
      <div className={compact ? 'model-config-panel__field model-config-panel__field--compact' : 'model-config-panel__field'}>
        {!compact && <label>{t('API Key')}</label>}
        <div className="model-config-panel__secret">
          {!keyReady ? (
            <input key="view" type="text" readOnly value={keyStatus === 'loading' ? t('加载中…') : t('读取失败')} />
          ) : fromEnv ? (
            <input key="view" type="text" readOnly value={compact ? t('环境变量') : t('使用环境变量 {{envVar}}', { envVar })} title={compact ? t('使用环境变量 {{envVar}}', { envVar }) : undefined} />
          ) : editing ? (
            <input
              key="edit"
              type="password"
              autoFocus
              autoComplete="new-password"
              spellCheck={false}
              value={keyInput}
              placeholder={t('输入新的 API Key')}
              onChange={e => onKeyInputChange(e.target.value)}
            />
          ) : (
            <input key="view" type="text" readOnly value={maskedValue} />
          )}
          {keyReady && !fromEnv && (
            <button
              type="button"
              className="model-config-panel__icon-btn"
              aria-label={editing ? t('取消编辑') : t('编辑 API Key')}
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
      <label
        className={compact ? 'model-config-panel__checkbox model-config-panel__checkbox--compact' : 'model-config-panel__checkbox'}
        title={compact ? envHint : undefined}
      >
        <input
          type="checkbox"
          checked={fromEnv}
          disabled={pending || (!envDetected && !fromEnv)}
          onChange={e => onFromEnvChange(e.target.checked)}
        />
        {compact ? t('环境变量') : envLabel}
      </label>
      {!compact && envStatus === 'loading' && (
        <div className="model-config-panel__checkbox">{t('正在检测环境变量 {{envVar}}…', { envVar })}</div>
      )}
      {!compact && envStatus === 'ready' && !envDetected && (
        <div className="model-config-panel__checkbox">{t('未检测到环境变量 {{envVar}}；修改环境变量后需重启 MintBot', { envVar })}</div>
      )}
    </>
  )
}
