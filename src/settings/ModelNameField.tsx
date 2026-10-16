// src/settings/ModelNameField.tsx — 设置窗口共用的「模型名称」下拉框
// 用法：ModelConfigPanel 的对话 / 摘要模型选择渲染 <ModelNameField />，PersonaModelPanel 的模型行渲染 <ModelNameField compact />；GET /models?type=[&presetId=][&purpose=]、POST /models
// 对应文件：src/settings/ModelConfigPanel.tsx / src/settings/PersonaModelPanel.tsx / src/errorText.ts / services/core/routes/models.ts / src/settings/settings.css
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ModelConfig } from '../../shared/types/index.js'
import { CORE_URL } from '../coreUrl.js'
import { isErrorBody, type ErrorBody } from '../../shared/errorCodes.js'
import { errorText } from '../errorText.js'

const TYPED_KEY_DEBOUNCE_MS = 500

interface ModelNameFieldProps {
  type: ModelConfig['type']
  current: string
  apiKey: string
  presetId?: string
  fromEnv?: boolean
  reloadKey?: number
  purpose?: 'summary'
  compact?: boolean
  onChange: (name: string) => void
}

export function ModelNameField({ type, current, apiKey, presetId, fromEnv, reloadKey = 0, purpose, compact = false, onChange }: ModelNameFieldProps) {
  const { t, i18n } = useTranslation()
  const [options, setOptions] = useState<string[]>([])
  const [isLoadingOptions, setIsLoadingOptions] = useState(true)
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  const loadOptions = useCallback(() => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setOptions([])
    setOptionsError(null)
    setIsLoadingOptions(true)
    const request = apiKey !== ''
      ? fetch(`${CORE_URL}/models`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, apiKey }),
          signal: controller.signal,
        })
      : fetch(
          `${CORE_URL}/models?type=${type}${presetId ? `&presetId=${encodeURIComponent(presetId)}` : ''}${purpose ? `&purpose=${purpose}` : ''}${fromEnv === undefined ? '' : `&fromEnv=${fromEnv ? 1 : 0}`}`,
          { signal: controller.signal }
        )
    request
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((body: { models: string[] } & Partial<ErrorBody>) => {
        if (controller.signal.aborted) return
        controllerRef.current = null
        setOptions(body.models)
        setOptionsError(isErrorBody(body) ? errorText(body, i18n.t) : null)
        setIsLoadingOptions(false)
      })
      .catch(err => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        controllerRef.current = null
        setOptionsError(i18n.t('获取模型列表失败'))
        setIsLoadingOptions(false)
      })
  }, [type, apiKey, presetId, purpose, fromEnv])

  useEffect(() => {
    const timer = apiKey !== '' ? setTimeout(loadOptions, TYPED_KEY_DEBOUNCE_MS) : null
    if (timer === null) loadOptions()
    return () => {
      if (timer !== null) clearTimeout(timer)
      controllerRef.current?.abort()
      controllerRef.current = null
    }
  }, [reloadKey, loadOptions, apiKey])

  const hasOptions = !isLoadingOptions && options.length > 0
  const statusText = isLoadingOptions ? t('加载中…') : (optionsError ?? t('没有可用的模型'))
  const showStatusHint = !hasOptions && current !== ''
  const choices = current !== '' && !options.includes(current) ? [current, ...options] : options

  const retryLoad = () => {
    if (!hasOptions && controllerRef.current === null) loadOptions()
  }

  return (
    <div className={compact ? 'model-config-panel__field model-config-panel__field--compact' : 'model-config-panel__field'}>
      {!compact && <label>{t('模型名称')}</label>}
      <select
        value={current}
        title={compact && showStatusHint ? statusText : undefined}
        onMouseDown={retryLoad}
        onFocus={retryLoad}
        onChange={e => onChange(e.target.value)}
      >
        {hasOptions ? (
          <>
            {current === '' && <option value="">{t('请选择')}</option>}
            {choices.map(name => (
              <option key={name} value={name}>{name}</option>
            ))}
          </>
        ) : (
          <option value={current}>{current !== '' ? current : statusText}</option>
        )}
      </select>
      {compact && !isLoadingOptions && optionsError !== null && (
        <span className="model-config-panel__error-mark" title={optionsError}>!</span>
      )}
      {!compact && showStatusHint && <span className="model-config-panel__hint">{statusText}</span>}
    </div>
  )
}
