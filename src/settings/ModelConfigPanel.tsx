import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ModelConfig } from '../../shared/types/index.js'
import './settings.css'

import { CORE_URL } from '../coreUrl.js'

interface ModelConfigSummary {
  type: 'anthropic' | 'openai' | 'ollama' | 'deepseek'
  hasAnthropicApiKey: boolean
  hasOpenaiApiKey: boolean
  hasDeepseekApiKey: boolean
  openaiBaseUrl?: string
  deepseekBaseUrl?: string
  ollamaBaseUrl?: string
  ollamaModel?: string
  modelName?: string
  maxTokens?: number
}

const MIN_MAX_TOKENS = 1
const MAX_MAX_TOKENS = 32000

interface ConfigModelResponse {
  modelProvider: ModelConfigSummary | null
  backgroundModelProvider: ModelConfigSummary | null
}

interface ModelFormState {
  type: 'anthropic' | 'openai' | 'ollama' | 'deepseek'
  apiKey: string
  modelName: string
  openaiBaseUrl: string
  deepseekBaseUrl: string
  ollamaBaseUrl: string
  ollamaModel: string
  maxTokens: string   
}

const BLANK_FORM: ModelFormState = {
  type: 'anthropic',
  apiKey: '',
  modelName: '',
  openaiBaseUrl: '',
  deepseekBaseUrl: '',
  ollamaBaseUrl: '',
  ollamaModel: '',
  maxTokens: '',
}

function summaryToFormState(summary: ModelConfigSummary | null): ModelFormState {
  if (!summary) return BLANK_FORM
  return {
    type: summary.type,
    apiKey: '',
    modelName: summary.modelName ?? '',
    openaiBaseUrl: summary.openaiBaseUrl ?? '',
    deepseekBaseUrl: summary.deepseekBaseUrl ?? '',
    ollamaBaseUrl: summary.ollamaBaseUrl ?? '',
    ollamaModel: summary.ollamaModel ?? '',
    maxTokens: summary.maxTokens !== undefined ? String(summary.maxTokens) : '',
  }
}

function buildPartialConfig(form: ModelFormState): Partial<ModelConfig> {
  const partial: Partial<ModelConfig> = { type: form.type }
  const trimmedApiKey = form.apiKey.trim()
  if (form.type === 'anthropic') {
    partial.modelName = form.modelName.trim()
    if (trimmedApiKey) partial.anthropicApiKey = trimmedApiKey
  } else if (form.type === 'openai') {
    partial.modelName = form.modelName.trim()
    partial.openaiBaseUrl = form.openaiBaseUrl.trim()
    if (trimmedApiKey) partial.openaiApiKey = trimmedApiKey
  } else if (form.type === 'deepseek') {
    partial.modelName = form.modelName.trim()
    partial.deepseekBaseUrl = form.deepseekBaseUrl.trim()
    if (trimmedApiKey) partial.deepseekApiKey = trimmedApiKey
  } else {
    partial.ollamaBaseUrl = form.ollamaBaseUrl.trim()
    partial.ollamaModel = form.ollamaModel.trim()
  }

  const trimmedMaxTokens = form.maxTokens.trim()
  if (trimmedMaxTokens) {
    const parsedMaxTokens = Number(trimmedMaxTokens)
    if (Number.isInteger(parsedMaxTokens)) partial.maxTokens = parsedMaxTokens
  }
  return partial
}

interface ModelFormFieldsProps {
  form: ModelFormState
  onChange: (next: ModelFormState) => void
  summary: ModelConfigSummary | null
}

function ModelFormFields({ form, onChange, summary }: ModelFormFieldsProps) {
  const hasKey = form.type === 'anthropic'
    ? summary?.hasAnthropicApiKey ?? false
    : form.type === 'openai'
      ? summary?.hasOpenaiApiKey ?? false
      : form.type === 'deepseek'
        ? summary?.hasDeepseekApiKey ?? false
        : false

  return (
    <>
      <div className="model-config-panel__field">
        <label>类型</label>
        <select
          value={form.type}
          onChange={e => onChange({
            ...form,
            type: e.target.value as ModelFormState['type'],
            apiKey: '',
            modelName: '',
          })}
        >
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
          <option value="deepseek">DeepSeek</option>
          <option value="ollama">Ollama</option>
        </select>
      </div>
      <div className="model-config-panel__field">
        <label>最大回复 token 数（max_tokens）</label>
        <input
          type="number"
          min={MIN_MAX_TOKENS}
          max={MAX_MAX_TOKENS}
          step={1}
          placeholder="默认 1000"
          value={form.maxTokens}
          onChange={e => onChange({ ...form, maxTokens: e.target.value })}
        />
      </div>
      {(form.type === 'anthropic' || form.type === 'openai' || form.type === 'deepseek') && (
        <>
          <div className="model-config-panel__field">
            <label>API Key</label>
            <input
              type="password"
              value={form.apiKey}
              placeholder={hasKey ? '已设置（如需更换请输入新值）' : '未设置'}
              onChange={e => onChange({ ...form, apiKey: e.target.value })}
            />
          </div>
          <div className="model-config-panel__field">
            <label>模型名称</label>
            <input
              value={form.modelName}
              onChange={e => onChange({ ...form, modelName: e.target.value })}
            />
          </div>
        </>
      )}
      {form.type === 'openai' && (
        <div className="model-config-panel__field">
          <label>Base URL（可选）</label>
          <input
            value={form.openaiBaseUrl}
            onChange={e => onChange({ ...form, openaiBaseUrl: e.target.value })}
          />
        </div>
      )}
      {form.type === 'deepseek' && (
        <div className="model-config-panel__field">
          <label>Base URL（可选）</label>
          <input
            value={form.deepseekBaseUrl}
            onChange={e => onChange({ ...form, deepseekBaseUrl: e.target.value })}
          />
        </div>
      )}
      {form.type === 'ollama' && (
        <>
          <div className="model-config-panel__field">
            <label>Ollama Base URL</label>
            <input
              value={form.ollamaBaseUrl}
              onChange={e => onChange({ ...form, ollamaBaseUrl: e.target.value })}
            />
          </div>
          <div className="model-config-panel__field">
            <label>Ollama 模型</label>
            <input
              value={form.ollamaModel}
              onChange={e => onChange({ ...form, ollamaModel: e.target.value })}
            />
          </div>
        </>
      )}
    </>
  )
}

export function ModelConfigPanel() {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [chatSummary, setChatSummary] = useState<ModelConfigSummary | null>(null)
  const [backgroundSummary, setBackgroundSummary] = useState<ModelConfigSummary | null>(null)
  const [chatForm, setChatForm] = useState<ModelFormState>(BLANK_FORM)
  const [sameAsChatModel, setSameAsChatModel] = useState(true)
  const [summaryForm, setSummaryForm] = useState<ModelFormState>(BLANK_FORM)
  const [isSaving, setIsSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const patchControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => {
      patchControllerRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    fetch(`${CORE_URL}/config/model`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data: ConfigModelResponse) => {
        setChatSummary(data.modelProvider)
        setBackgroundSummary(data.backgroundModelProvider)
        setChatForm(summaryToFormState(data.modelProvider))
        setSameAsChatModel(data.backgroundModelProvider === null)
        setSummaryForm(summaryToFormState(data.backgroundModelProvider))
      })
      .catch(() => {
        setLoadError('加载模型配置失败，请稍后重试')
      })
      .finally(() => setLoading(false))
  }, [])

  const handleSave = useCallback(async () => {
    patchControllerRef.current?.abort()
    const controller = new AbortController()
    patchControllerRef.current = controller
    setIsSaving(true)
    setErrorMessage(null)
    setSaveNotice(null)

    const body: { modelProvider: Partial<ModelConfig>; backgroundModelProvider: Partial<ModelConfig> | null } = {
      modelProvider: buildPartialConfig(chatForm),
      backgroundModelProvider: sameAsChatModel ? null : buildPartialConfig(summaryForm),
    }

    try {
      const response = await fetch(`${CORE_URL}/config/model`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`)
      }

      const data: ConfigModelResponse = await response.json()
      if (controller.signal.aborted) return

      setChatSummary(data.modelProvider)
      setBackgroundSummary(data.backgroundModelProvider)
      setChatForm(summaryToFormState(data.modelProvider))
      setSameAsChatModel(data.backgroundModelProvider === null)
      setSummaryForm(summaryToFormState(data.backgroundModelProvider))
      setSaveNotice('已保存')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setErrorMessage(err instanceof Error ? err.message : '保存模型配置失败，请稍后重试')
    } finally {
      setIsSaving(false)
    }
  }, [chatForm, summaryForm, sameAsChatModel])

  if (loading) {
    return <div className="memory-loading">加载中…</div>
  }

  if (loadError) {
    return <div className="character-panel__error">{loadError}</div>
  }

  return (
    <div className="model-config-panel">
      <div className="model-config-panel__section">
        <div className="model-config-panel__section-label">对话模型</div>
        <ModelFormFields form={chatForm} onChange={setChatForm} summary={chatSummary} />
      </div>

      <div className="model-config-panel__section">
        <div className="model-config-panel__section-label">摘要模型</div>
        <label className="model-config-panel__checkbox">
          <input
            type="checkbox"
            checked={sameAsChatModel}
            onChange={e => setSameAsChatModel(e.target.checked)}
          />
          使用与对话模型相同
        </label>
        {!sameAsChatModel && (
          <ModelFormFields form={summaryForm} onChange={setSummaryForm} summary={backgroundSummary} />
        )}
      </div>

      <button className="rename-btn" onClick={handleSave} disabled={isSaving}>
        {isSaving ? '保存中…' : '保存'}
      </button>

      {errorMessage && <div className="character-panel__error">{errorMessage}</div>}
      {saveNotice && <div className="character-panel__notice">{saveNotice}</div>}
    </div>
  )
}
