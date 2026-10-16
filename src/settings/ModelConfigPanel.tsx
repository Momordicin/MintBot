// src/settings/ModelConfigPanel.tsx — 设置窗口的"模型配置"面板：API Key / Ollama 地址 / 对话模型 / 摘要模型
// 用法：SettingsApp 里渲染 <ModelConfigPanel />（无 props）；GET/PATCH /config/model
// 对应文件：src/settings/SettingsApp.tsx / src/settings/SubscriptionLogin.tsx / src/settings/ApiKeyField.tsx / src/settings/ModelNameField.tsx / services/core/routes/config.ts / shared/types/index.ts
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ModelConfig } from '../../shared/types/index.js'
import './settings.css'

import { CORE_URL } from '../coreUrl.js'
import { ApiKeyField, ENV_VAR, type KeyProvider } from './ApiKeyField.js'
import { ModelNameField } from './ModelNameField.js'
import { SubscriptionLogin } from './SubscriptionLogin.js'

type ProviderType = 'anthropic' | 'openai' | 'ollama' | 'deepseek'

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
  return (
    <div className="model-config-panel__group">
      <div className="model-config-panel__section-label">{PROVIDER_LABEL[provider]}</div>
      <ApiKeyField
        summary={summary}
        envDetected={summary.envDetected}
        envVar={ENV_VAR[provider]}
        fromEnv={fromEnv}
        keyInput={keyInput}
        editing={editing}
        onKeyInputChange={onKeyInputChange}
        onEditingChange={onEditingChange}
        onFromEnvChange={onFromEnvChange}
      />
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
  typedKeys: Record<KeyProvider, string>
  fromEnvs: Record<KeyProvider, boolean>
  onChange: (next: ModelSelection) => void
}

function ModelSelectionFields({ selection, providerOptions, reloadKey, typedKeys, fromEnvs, onChange }: ModelSelectionFieldsProps) {
  const current = selection.type === 'ollama' ? selection.ollamaModel : selection.modelName
  const typedKey = selection.type === 'ollama' ? '' : typedKeys[selection.type].trim()

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
      <ModelNameField
        type={selection.type}
        current={current}
        apiKey={typedKey}
        fromEnv={selection.type === 'ollama' ? undefined : fromEnvs[selection.type]}
        reloadKey={reloadKey}
        onChange={name => onChange(
          selection.type === 'ollama'
            ? { ...selection, ollamaModel: name }
            : { ...selection, modelName: name }
        )}
      />
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

      <SubscriptionLogin />

      <div className="model-config-panel__section">
        <div className="model-config-panel__section-label">对话模型</div>
        <ModelSelectionFields
          selection={form.chat}
          providerOptions={providerOptionsFor(form.chat.type)}
          reloadKey={modelsReloadKey}
          typedKeys={form.keyInputs}
          fromEnvs={form.fromEnv}
          onChange={chat => setForm(prev => ({ ...prev, chat }))}
        />
        <div className="model-config-panel__field model-config-panel__field--short">
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
            typedKeys={form.keyInputs}
            fromEnvs={form.fromEnv}
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
