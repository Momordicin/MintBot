// src/settings/ModelConfigPanel.tsx — 设置窗口的"模型配置"面板：API Key / Ollama 地址 / 对话模型 / 摘要模型
// 用法：SettingsApp 里渲染 <ModelConfigPanel />（无 props）；GET/PATCH /config/model；GET /models?type=
// 对应文件：src/settings/SettingsApp.tsx / services/core/routes/config.ts / services/core/routes/models.ts / shared/types/index.ts
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ModelConfig } from '../../shared/types/index.js'
import './settings.css'

import { CORE_URL } from '../coreUrl.js'

type ProviderType = 'anthropic' | 'openai' | 'ollama' | 'deepseek'
type KeyProvider = 'anthropic' | 'openai' | 'deepseek'

interface KeySummary {
  hasKey: boolean
  last4: string | null
  fromEnv: boolean
  envDetected: boolean
}

interface ModelConfigSummary {
  type: ProviderType
  modelName?: string
  ollamaModel?: string
  ollamaBaseUrl?: string
  openaiBaseUrl?: string
  deepseekBaseUrl?: string
  maxTokens?: number
  keys: Record<KeyProvider, KeySummary>
}

interface BackgroundSummary {
  type: ProviderType
  modelName?: string
  ollamaModel?: string
}

interface ConfigModelResponse {
  modelProvider: ModelConfigSummary | null
  backgroundModelProvider: BackgroundSummary | null
}

interface ModelSelection {
  type: ProviderType
  modelName: string
  ollamaModel: string
}

interface FormState {
  keyInputs: Record<KeyProvider, string>
  keyEditing: Record<KeyProvider, boolean>
  fromEnv: Record<KeyProvider, boolean>
  openaiBaseUrl: string
  deepseekBaseUrl: string
  ollamaBaseUrl: string
  maxTokens: string
  chat: ModelSelection
  sameAsChat: boolean
  summary: ModelSelection
}

const MIN_MAX_TOKENS = 1
const MAX_MAX_TOKENS = 32000

const KEY_PROVIDERS: readonly KeyProvider[] = ['anthropic', 'openai', 'deepseek']

const PROVIDER_LABEL: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  ollama: 'Ollama',
}

const ENV_VAR: Record<KeyProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
}

const BLANK_KEY_SUMMARY: KeySummary = { hasKey: false, last4: null, fromEnv: false, envDetected: false }

const BLANK_KEYS: Record<KeyProvider, KeySummary> = {
  anthropic: BLANK_KEY_SUMMARY,
  openai: BLANK_KEY_SUMMARY,
  deepseek: BLANK_KEY_SUMMARY,
}

function toSelection(source: { type: ProviderType; modelName?: string; ollamaModel?: string } | null, fallbackType: ProviderType): ModelSelection {
  return {
    type: source?.type ?? fallbackType,
    modelName: source?.modelName ?? '',
    ollamaModel: source?.ollamaModel ?? '',
  }
}

function toFormState(data: ConfigModelResponse): FormState {
  const chat = data.modelProvider
  const keys = chat?.keys ?? BLANK_KEYS
  return {
    keyInputs: { anthropic: '', openai: '', deepseek: '' },
    keyEditing: { anthropic: false, openai: false, deepseek: false },
    fromEnv: { anthropic: keys.anthropic.fromEnv, openai: keys.openai.fromEnv, deepseek: keys.deepseek.fromEnv },
    openaiBaseUrl: chat?.openaiBaseUrl ?? '',
    deepseekBaseUrl: chat?.deepseekBaseUrl ?? '',
    ollamaBaseUrl: chat?.ollamaBaseUrl ?? '',
    maxTokens: chat?.maxTokens !== undefined ? String(chat.maxTokens) : '',
    chat: toSelection(chat, 'anthropic'),
    sameAsChat: data.backgroundModelProvider === null,
    summary: toSelection(data.backgroundModelProvider, chat?.type ?? 'anthropic'),
  }
}

function buildSelectionPatch(selection: ModelSelection): Partial<ModelConfig> {
  return selection.type === 'ollama'
    ? { type: 'ollama', ollamaModel: selection.ollamaModel.trim() }
    : { type: selection.type, modelName: selection.modelName.trim() }
}

function buildGlobalPatch(form: FormState): Partial<ModelConfig> {
  const patch: Partial<ModelConfig> = {
    ...buildSelectionPatch(form.chat),
    anthropicApiKeyFromEnv: form.fromEnv.anthropic,
    openaiApiKeyFromEnv: form.fromEnv.openai,
    deepseekApiKeyFromEnv: form.fromEnv.deepseek,
    openaiBaseUrl: form.openaiBaseUrl.trim(),
    deepseekBaseUrl: form.deepseekBaseUrl.trim(),
    ollamaBaseUrl: form.ollamaBaseUrl.trim(),
  }
  const anthropicKey = form.keyInputs.anthropic.trim()
  const openaiKey = form.keyInputs.openai.trim()
  const deepseekKey = form.keyInputs.deepseek.trim()
  if (anthropicKey) patch.anthropicApiKey = anthropicKey
  if (openaiKey) patch.openaiApiKey = openaiKey
  if (deepseekKey) patch.deepseekApiKey = deepseekKey

  const trimmedMaxTokens = form.maxTokens.trim()
  if (trimmedMaxTokens) {
    const parsedMaxTokens = Number(trimmedMaxTokens)
    if (Number.isInteger(parsedMaxTokens)) patch.maxTokens = parsedMaxTokens
  }
  return patch
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

interface KeyGroupProps {
  provider: KeyProvider
  summary: KeySummary
  keyInput: string
  editing: boolean
  fromEnv: boolean
  onKeyInputChange: (value: string) => void
  onEditingChange: (editing: boolean) => void
  onFromEnvChange: (checked: boolean) => void
  baseUrl?: string
  onBaseUrlChange?: (value: string) => void
}

function KeyGroup({ provider, summary, keyInput, editing, fromEnv, onKeyInputChange, onEditingChange, onFromEnvChange, baseUrl, onBaseUrlChange }: KeyGroupProps) {
  const envVar = ENV_VAR[provider]
  const maskedValue = summary.hasKey ? `••••••••${summary.last4 ?? ''}` : '未填写'
  return (
    <div className="model-config-panel__group">
      <div className="model-config-panel__section-label">{PROVIDER_LABEL[provider]}</div>
      <div className="model-config-panel__field">
        <label>API Key</label>
        <div className="model-config-panel__secret">
          {fromEnv ? (
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
          {!fromEnv && (
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
          disabled={!summary.envDetected && !fromEnv}
          onChange={e => onFromEnvChange(e.target.checked)}
        />
        自动配置 API Key（使用环境变量 {envVar}）
      </label>
      {!summary.envDetected && (
        <div className="model-config-panel__checkbox">未检测到环境变量 {envVar}；修改环境变量后需重启 MintBot</div>
      )}
      {onBaseUrlChange && (
        <div className="model-config-panel__field">
          <label>Base URL（可选）</label>
          <input value={baseUrl ?? ''} onChange={e => onBaseUrlChange(e.target.value)} />
        </div>
      )}
    </div>
  )
}

interface ModelSelectionFieldsProps {
  selection: ModelSelection
  providerOptions: ProviderType[]
  reloadKey: number
  onChange: (next: ModelSelection) => void
}

function ModelSelectionFields({ selection, providerOptions, reloadKey, onChange }: ModelSelectionFieldsProps) {
  const [options, setOptions] = useState<string[]>([])
  const [isLoadingOptions, setIsLoadingOptions] = useState(true)
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  const loadOptions = useCallback((type: ProviderType) => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setOptions([])
    setOptionsError(null)
    setIsLoadingOptions(true)
    fetch(`${CORE_URL}/models?type=${type}`, { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((body: { models: string[]; error?: string }) => {
        if (controller.signal.aborted) return
        controllerRef.current = null
        setOptions(body.models)
        setOptionsError(body.error ?? null)
        setIsLoadingOptions(false)
      })
      .catch(err => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        controllerRef.current = null
        setOptionsError('获取模型列表失败')
        setIsLoadingOptions(false)
      })
  }, [])

  useEffect(() => {
    loadOptions(selection.type)
    return () => {
      controllerRef.current?.abort()
      controllerRef.current = null
    }
  }, [selection.type, reloadKey, loadOptions])

  const current = selection.type === 'ollama' ? selection.ollamaModel : selection.modelName
  const hasOptions = !isLoadingOptions && options.length > 0
  const statusText = isLoadingOptions ? '加载中…' : (optionsError ?? '没有可用的模型')
  const showStatusHint = !hasOptions && current !== ''
  const choices = current !== '' && !options.includes(current) ? [current, ...options] : options

  const retryLoad = () => {
    if (!hasOptions && controllerRef.current === null) loadOptions(selection.type)
  }

  return (
    <>
      <div className="model-config-panel__field">
        <label>类型</label>
        <select
          value={selection.type}
          onChange={e => onChange({ ...selection, type: e.target.value as ProviderType, modelName: '' })}
        >
          {providerOptions.map(option => (
            <option key={option} value={option}>{PROVIDER_LABEL[option]}</option>
          ))}
        </select>
      </div>
      <div className="model-config-panel__field">
        <label>模型名称</label>
        <select
          value={current}
          onMouseDown={retryLoad}
          onFocus={retryLoad}
          onChange={e => onChange(
            selection.type === 'ollama'
              ? { ...selection, ollamaModel: e.target.value }
              : { ...selection, modelName: e.target.value }
          )}
        >
          {hasOptions ? (
            <>
              {current === '' && <option value="">请选择</option>}
              {choices.map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
            </>
          ) : (
            <option value={current}>{current !== '' ? current : statusText}</option>
          )}
        </select>
        {showStatusHint && <span className="model-config-panel__hint">{statusText}</span>}
      </div>
    </>
  )
}

export function ModelConfigPanel() {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [keys, setKeys] = useState<Record<KeyProvider, KeySummary>>(BLANK_KEYS)
  const [form, setForm] = useState<FormState>(() => toFormState({ modelProvider: null, backgroundModelProvider: null }))
  const [isSaving, setIsSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const [modelsReloadKey, setModelsReloadKey] = useState(0)
  const patchControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => {
      patchControllerRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${CORE_URL}/config/model`, { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data: ConfigModelResponse) => {
        setKeys(data.modelProvider?.keys ?? BLANK_KEYS)
        setForm(toFormState(data))
      })
      .catch(err => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setLoadError('加载模型配置失败，请稍后重试')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [])

  const handleSave = useCallback(async () => {
    patchControllerRef.current?.abort()
    const controller = new AbortController()
    patchControllerRef.current = controller
    setIsSaving(true)
    setErrorMessage(null)
    setSaveNotice(null)

    const body: { modelProvider: Partial<ModelConfig>; backgroundModelProvider: Partial<ModelConfig> | null } = {
      modelProvider: buildGlobalPatch(form),
      backgroundModelProvider: form.sameAsChat ? null : buildSelectionPatch(form.summary),
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

      setKeys(data.modelProvider?.keys ?? BLANK_KEYS)
      setForm(toFormState(data))
      setModelsReloadKey(prev => prev + 1)
      setSaveNotice('已保存')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setErrorMessage(err instanceof Error ? err.message : '保存模型配置失败，请稍后重试')
    } finally {
      setIsSaving(false)
    }
  }, [form])

  if (loading) {
    return <div className="memory-loading">加载中…</div>
  }

  if (loadError) {
    return <div className="character-panel__error">{loadError}</div>
  }

  const isConfigured = (provider: KeyProvider): boolean =>
    form.fromEnv[provider]
      ? keys[provider].envDetected
      : keys[provider].hasKey || form.keyInputs[provider].trim() !== ''

  const providerOptionsFor = (current: ProviderType): ProviderType[] => {
    const options: ProviderType[] = [...KEY_PROVIDERS.filter(isConfigured), 'ollama']
    return options.includes(current) ? options : [current, ...options]
  }

  const setKeyInput = (provider: KeyProvider, value: string) =>
    setForm(prev => ({ ...prev, keyInputs: { ...prev.keyInputs, [provider]: value } }))

  const setKeyEditing = (provider: KeyProvider, editing: boolean) =>
    setForm(prev => ({ ...prev, keyEditing: { ...prev.keyEditing, [provider]: editing } }))

  const setFromEnv = (provider: KeyProvider, checked: boolean) =>
    setForm(prev => ({
      ...prev,
      fromEnv: { ...prev.fromEnv, [provider]: checked },
      keyInputs: checked ? { ...prev.keyInputs, [provider]: '' } : prev.keyInputs,
      keyEditing: checked ? { ...prev.keyEditing, [provider]: false } : prev.keyEditing,
    }))

  return (
    <fieldset className="model-config-panel" disabled={isSaving}>
      {isSaving && <div className="model-config-panel__saving"><div className="model-config-panel__saving-label">保存中…</div></div>}
      <div className="model-config-panel__section">
        <div className="model-config-panel__section-label">API Key</div>
        <KeyGroup
          provider="anthropic"
          summary={keys.anthropic}
          keyInput={form.keyInputs.anthropic}
          editing={form.keyEditing.anthropic}
          fromEnv={form.fromEnv.anthropic}
          onKeyInputChange={value => setKeyInput('anthropic', value)}
          onEditingChange={editing => setKeyEditing('anthropic', editing)}
          onFromEnvChange={checked => setFromEnv('anthropic', checked)}
        />
        <KeyGroup
          provider="openai"
          summary={keys.openai}
          keyInput={form.keyInputs.openai}
          editing={form.keyEditing.openai}
          fromEnv={form.fromEnv.openai}
          onKeyInputChange={value => setKeyInput('openai', value)}
          onEditingChange={editing => setKeyEditing('openai', editing)}
          onFromEnvChange={checked => setFromEnv('openai', checked)}
          baseUrl={form.openaiBaseUrl}
          onBaseUrlChange={value => setForm(prev => ({ ...prev, openaiBaseUrl: value }))}
        />
        <KeyGroup
          provider="deepseek"
          summary={keys.deepseek}
          keyInput={form.keyInputs.deepseek}
          editing={form.keyEditing.deepseek}
          fromEnv={form.fromEnv.deepseek}
          onKeyInputChange={value => setKeyInput('deepseek', value)}
          onEditingChange={editing => setKeyEditing('deepseek', editing)}
          onFromEnvChange={checked => setFromEnv('deepseek', checked)}
          baseUrl={form.deepseekBaseUrl}
          onBaseUrlChange={value => setForm(prev => ({ ...prev, deepseekBaseUrl: value }))}
        />
      </div>

      <div className="model-config-panel__section">
        <div className="model-config-panel__section-label">Ollama</div>
        <div className="model-config-panel__field">
          <label>Ollama Base URL</label>
          <input
            value={form.ollamaBaseUrl}
            onChange={e => setForm(prev => ({ ...prev, ollamaBaseUrl: e.target.value }))}
          />
        </div>
      </div>

      <div className="model-config-panel__section">
        <div className="model-config-panel__section-label">对话模型</div>
        <ModelSelectionFields
          selection={form.chat}
          providerOptions={providerOptionsFor(form.chat.type)}
          reloadKey={modelsReloadKey}
          onChange={chat => setForm(prev => ({ ...prev, chat }))}
        />
        <div className="model-config-panel__field">
          <label>最大回复 token 数（max_tokens）</label>
          <input
            type="number"
            min={MIN_MAX_TOKENS}
            max={MAX_MAX_TOKENS}
            step={1}
            placeholder="默认 1000"
            value={form.maxTokens}
            onChange={e => setForm(prev => ({ ...prev, maxTokens: e.target.value }))}
          />
        </div>
      </div>

      <div className="model-config-panel__section">
        <div className="model-config-panel__section-label">摘要模型</div>
        <label className="model-config-panel__checkbox">
          <input
            type="checkbox"
            checked={form.sameAsChat}
            onChange={e => setForm(prev => ({ ...prev, sameAsChat: e.target.checked }))}
          />
          使用与对话模型相同
        </label>
        {!form.sameAsChat && (
          <ModelSelectionFields
            selection={form.summary}
            providerOptions={providerOptionsFor(form.summary.type)}
            reloadKey={modelsReloadKey}
            onChange={summary => setForm(prev => ({ ...prev, summary }))}
          />
        )}
      </div>

      <button className="rename-btn" onClick={handleSave} disabled={isSaving}>
        {isSaving ? '保存中…' : '保存'}
      </button>

      {errorMessage && <div className="character-panel__error">{errorMessage}</div>}
      {saveNotice && <div className="character-panel__notice">{saveNotice}</div>}
    </fieldset>
  )
}
