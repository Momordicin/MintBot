// src/settings/ModelConfigPanel.tsx — 设置窗口的"模型配置"面板：API Key / Ollama 地址 / 对话模型 / 摘要模型，各项改动后自动保存
// 用法：SettingsApp 里渲染 <ModelConfigPanel />（无 props）；GET/PATCH /config/model、GET /models?type=
// 对应文件：src/settings/SettingsApp.tsx / src/settings/SubscriptionLogin.tsx / src/settings/ApiKeyField.tsx / src/settings/ModelNameField.tsx / src/errorText.ts / services/core/routes/config.ts / services/core/routes/models.ts / shared/types/index.ts
import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ModelConfig } from '../../shared/types/index.js'
import { isErrorBody } from '../../shared/errorCodes.js'
import { errorText } from '../errorText.js'
import './settings.css'

import { CORE_URL } from '../coreUrl.js'
import { ApiKeyField, ENV_VAR, TestResultIcon, type ApiKeyTestResult, type KeyProvider, type TestState } from './ApiKeyField.js'
import { ModelNameField } from './ModelNameField.js'
import { SubscriptionLogin } from './SubscriptionLogin.js'

type ProviderType = 'anthropic' | 'openai' | 'ollama' | 'deepseek'

interface KeySummary {
  hasKey: boolean
  last4: string | null
  fromEnv: boolean
  envDetected: boolean
  envCleared: boolean
}

interface ModelConfigSummary {
  type: ProviderType
  modelName?: string
  ollamaModel?: string
  ollamaBaseUrl?: string
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
  ollamaBaseUrl: string
  maxTokens: string
  chat: ModelSelection
  sameAsChat: boolean
  summary: ModelSelection
}

const MIN_MAX_TOKENS = 1
const MAX_MAX_TOKENS = 32000

const KEY_PROVIDERS: readonly KeyProvider[] = ['anthropic', 'openai', 'deepseek']

const KEY_FIELD = {
  anthropic: { key: 'anthropicApiKey', fromEnv: 'anthropicApiKeyFromEnv' },
  openai: { key: 'openaiApiKey', fromEnv: 'openaiApiKeyFromEnv' },
  deepseek: { key: 'deepseekApiKey', fromEnv: 'deepseekApiKeyFromEnv' },
} as const

const RELOAD_FIELDS: readonly string[] = [
  ...KEY_PROVIDERS.flatMap(provider => [KEY_FIELD[provider].key, KEY_FIELD[provider].fromEnv]),
  'ollamaBaseUrl',
]

type ItemId = 'chat' | 'maxTokens' | 'summary'

type PatchBody = { modelProvider?: Partial<ModelConfig>; backgroundModelProvider?: Partial<ModelConfig> | null }

const PROVIDER_LABEL: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  ollama: 'Ollama',
}

const BLANK_KEY_SUMMARY: KeySummary = { hasKey: false, last4: null, fromEnv: false, envDetected: false, envCleared: false }

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
  return {
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

function chatFromSaved(saved: ConfigModelResponse, prev: FormState): FormState {
  return { ...prev, chat: toSelection(saved.modelProvider, 'anthropic') }
}

function maxTokensFromSaved(saved: ConfigModelResponse, prev: FormState): FormState {
  const maxTokens = saved.modelProvider?.maxTokens
  return { ...prev, maxTokens: maxTokens !== undefined ? String(maxTokens) : '' }
}

function summaryFromSaved(saved: ConfigModelResponse, prev: FormState): FormState {
  return {
    ...prev,
    sameAsChat: saved.backgroundModelProvider === null,
    summary: toSelection(saved.backgroundModelProvider, saved.modelProvider?.type ?? 'anthropic'),
  }
}

function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

interface KeyGroupProps {
  provider: KeyProvider
  summary: KeySummary
  keyInput: string
  editing: boolean
  envError: string | null
  onKeyInputChange: (value: string) => void
  onEditingChange: (editing: boolean) => void
  onCommit: (key: string) => Promise<string | null>
  onEnvChange: (checked: boolean) => void
  onTest: () => Promise<ApiKeyTestResult>
}

function KeyGroup({ provider, summary, keyInput, editing, envError, onKeyInputChange, onEditingChange, onCommit, onEnvChange, onTest }: KeyGroupProps) {
  const { t } = useTranslation()
  return (
    <div className="model-config-panel__group">
      <ApiKeyField
        label={PROVIDER_LABEL[provider]}
        summary={summary}
        keyInput={keyInput}
        onKeyInputChange={onKeyInputChange}
        editing={editing}
        onEditingChange={onEditingChange}
        env={{ envVar: ENV_VAR[provider], detected: summary.envDetected, fromEnv: summary.fromEnv, status: 'ready', onChange: onEnvChange }}
        onCommit={onCommit}
        onTest={onTest}
        notice={summary.envCleared ? t('未检测到环境变量 {{envVar}}，已取消自动配置', { envVar: ENV_VAR[provider] }) : undefined}
      />
      {envError !== null && <div className="character-panel__error">{envError}</div>}
    </div>
  )
}

interface OllamaUrlFieldProps {
  saved: string
  onCommit: (value: string) => Promise<string | null>
  onTest: () => Promise<ApiKeyTestResult>
}

function OllamaUrlField({ saved, onCommit, onTest }: OllamaUrlFieldProps) {
  const { t } = useTranslation()
  const inputId = useId()
  const [value, setValue] = useState(saved)
  const [error, setError] = useState<string | null>(null)
  const [test, setTest] = useState<{ state: TestState; reason: string | null }>({ state: 'idle', reason: null })
  const testSeqRef = useRef(0)

  useEffect(() => {
    setValue(saved)
  }, [saved])

  useEffect(() => {
    testSeqRef.current += 1
    setTest({ state: 'idle', reason: null })
  }, [saved, value])

  const commit = async () => {
    const trimmed = value.trim()
    if (trimmed === saved) {
      setValue(trimmed)
      setError(null)
      return
    }
    if (trimmed !== '' && !isHttpUrl(trimmed)) {
      setError(t('地址格式不对，未保存'))
      return
    }
    setError(null)
    const reason = await onCommit(trimmed)
    if (reason !== null) {
      setValue(saved)
      setError(reason)
    }
  }

  const runTest = async () => {
    const seq = testSeqRef.current
    setTest({ state: 'testing', reason: null })
    const result = await onTest()
    if (seq !== testSeqRef.current) return
    setTest(result.ok ? { state: 'ok', reason: null } : { state: 'fail', reason: result.reason })
  }

  return (
    <div className="api-key-field">
      <label className="api-key-field__label" htmlFor={inputId}>Ollama</label>
      <div className="model-config-panel__field api-key-field__box">
        <input
          id={inputId}
          value={value}
          placeholder="http://localhost:11434"
          spellCheck={false}
          onChange={e => {
            setError(null)
            setValue(e.target.value)
          }}
          onBlur={() => void commit()}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur()
            }
          }}
        />
      </div>
      <span />
      <button
        type="button"
        className="rename-btn"
        disabled={test.state === 'testing' || value.trim() !== saved}
        onClick={() => void runTest()}
      >
        {t('测试')}
      </button>
      <TestResultIcon state={test.state} reason={test.reason} />
      {error !== null && <div className="api-key-field__note character-panel__error">{error}</div>}
      {test.state === 'fail' && <div className="api-key-field__note api-key-field__note--fail" title={test.reason ?? undefined}>{test.reason}</div>}
    </div>
  )
}

interface ModelSelectionFieldsProps {
  selection: ModelSelection
  providerOptions: ProviderType[]
  reloadKey: number
  fromEnvs: Record<KeyProvider, boolean>
  onChange: (next: ModelSelection) => void
  onCommit: (next: ModelSelection) => void
}

function ModelSelectionFields({ selection, providerOptions, reloadKey, fromEnvs, onChange, onCommit }: ModelSelectionFieldsProps) {
  const { t } = useTranslation()
  const typeId = useId()
  const current = selection.type === 'ollama' ? selection.ollamaModel : selection.modelName

  return (
    <>
      <div className="model-config-panel__field">
        <label htmlFor={typeId}>{t('类型')}</label>
        <select
          id={typeId}
          value={selection.type}
          onChange={e => onChange({ ...selection, type: e.target.value as ProviderType, modelName: '', ollamaModel: '' })}
        >
          {providerOptions.map(option => (
            <option key={option} value={option}>{PROVIDER_LABEL[option]}</option>
          ))}
        </select>
      </div>
      <ModelNameField
        type={selection.type}
        current={current}
        apiKey=""
        fromEnv={selection.type === 'ollama' ? undefined : fromEnvs[selection.type]}
        reloadKey={reloadKey}
        onChange={name => {
          const next = selection.type === 'ollama'
            ? { ...selection, ollamaModel: name }
            : { ...selection, modelName: name }
          onChange(next)
          onCommit(next)
        }}
      />
    </>
  )
}

export function ModelConfigPanel() {
  const { t, i18n } = useTranslation()
  const maxTokensId = useId()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [keys, setKeys] = useState<Record<KeyProvider, KeySummary>>(BLANK_KEYS)
  const [form, setForm] = useState<FormState>(() => toFormState({ modelProvider: null, backgroundModelProvider: null }))
  const [saving, setSaving] = useState(false)
  const [keyInputs, setKeyInputs] = useState<Record<KeyProvider, string>>({ anthropic: '', openai: '', deepseek: '' })
  const [keyEditing, setKeyEditing] = useState<Record<KeyProvider, boolean>>({ anthropic: false, openai: false, deepseek: false })
  const [envErrors, setEnvErrors] = useState<Record<KeyProvider, string | null>>({ anthropic: null, openai: null, deepseek: null })
  const [itemErrors, setItemErrors] = useState<Record<ItemId, string | null>>({ chat: null, maxTokens: null, summary: null })
  const [modelsReloadKey, setModelsReloadKey] = useState(0)
  const patchControllerRef = useRef<AbortController | null>(null)
  const savedRef = useRef<ConfigModelResponse>({ modelProvider: null, backgroundModelProvider: null })

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
        savedRef.current = data
        setKeys(data.modelProvider?.keys ?? BLANK_KEYS)
        setForm(toFormState(data))
      })
      .catch(err => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setLoadError(i18n.t('加载模型配置失败，请稍后重试'))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [])

  const patchConfig = useCallback(async (body: PatchBody): Promise<string | null> => {
    patchControllerRef.current?.abort()
    const controller = new AbortController()
    patchControllerRef.current = controller
    setSaving(true)
    try {
      const response = await fetch(`${CORE_URL}/config/model`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        return isErrorBody(payload) ? errorText(payload, i18n.t) : `HTTP ${response.status}`
      }
      const data: ConfigModelResponse = await response.json()
      if (controller.signal.aborted) return null
      savedRef.current = data
      setKeys(data.modelProvider?.keys ?? BLANK_KEYS)
      if (Object.keys(body.modelProvider ?? {}).some(field => RELOAD_FIELDS.includes(field))) {
        setModelsReloadKey(prev => prev + 1)
      }
      return null
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null
      return err instanceof Error ? err.message : i18n.t('保存模型配置失败，请稍后重试')
    } finally {
      setSaving(false)
    }
  }, [])

  const saveItem = async (item: ItemId, body: PatchBody, syncFromSaved: (saved: ConfigModelResponse, prev: FormState) => FormState) => {
    setItemErrors(prev => ({ ...prev, [item]: null }))
    const reason = await patchConfig(body)
    setForm(prev => syncFromSaved(savedRef.current, prev))
    if (reason !== null) setItemErrors(prev => ({ ...prev, [item]: reason }))
  }

  const saveOllamaUrl = async (value: string): Promise<string | null> => {
    const reason = await patchConfig({ modelProvider: { ollamaBaseUrl: value } })
    if (reason === null) setForm(prev => ({ ...prev, ollamaBaseUrl: savedRef.current.modelProvider?.ollamaBaseUrl ?? '' }))
    return reason
  }

  const saveChat = (next: ModelSelection) =>
    saveItem('chat', { modelProvider: buildSelectionPatch(next) }, chatFromSaved)

  const saveSummary = (body: PatchBody) => saveItem('summary', body, summaryFromSaved)

  const handleSameAsChatChange = (checked: boolean) => {
    setForm(prev => checked
      ? { ...prev, sameAsChat: true }
      : { ...prev, sameAsChat: false, summary: { type: savedRef.current.modelProvider?.type ?? 'anthropic', modelName: '', ollamaModel: '' } })
    setItemErrors(prev => ({ ...prev, summary: null }))
    if (checked) void saveSummary({ backgroundModelProvider: null })
  }

  const handleMaxTokensBlur = () => {
    const trimmed = form.maxTokens.trim()
    if (trimmed === '') {
      setForm(prev => maxTokensFromSaved(savedRef.current, prev))
      setItemErrors(prev => ({ ...prev, maxTokens: null }))
      return
    }
    const parsed = Number(trimmed)
    if (!Number.isInteger(parsed) || parsed < MIN_MAX_TOKENS || parsed > MAX_MAX_TOKENS) {
      setItemErrors(prev => ({ ...prev, maxTokens: t('需要 1 到 32000 之间的整数，未保存') }))
      return
    }
    if (parsed === savedRef.current.modelProvider?.maxTokens) return
    void saveItem('maxTokens', { modelProvider: { maxTokens: parsed } }, maxTokensFromSaved)
  }

  const handleKeyCommit = (provider: KeyProvider) => (key: string) =>
    patchConfig({ modelProvider: { [KEY_FIELD[provider].key]: key } })

  const handleEnvChange = async (provider: KeyProvider, checked: boolean) => {
    setEnvErrors(prev => ({ ...prev, [provider]: null }))
    const reason = await patchConfig({ modelProvider: { [KEY_FIELD[provider].fromEnv]: checked } })
    setEnvErrors(prev => ({ ...prev, [provider]: reason }))
    if (reason === null && checked) {
      setKeyInputs(prev => ({ ...prev, [provider]: '' }))
      setKeyEditing(prev => ({ ...prev, [provider]: false }))
    }
  }

  const testKey = async (provider: KeyProvider | 'ollama'): Promise<ApiKeyTestResult> => {
    try {
      const response = await fetch(`${CORE_URL}/models?type=${provider}`)
      if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
      const body: unknown = await response.json()
      return isErrorBody(body) ? { ok: false, reason: errorText(body, i18n.t) } : { ok: true }
    } catch {
      return { ok: false, reason: i18n.t('连不上服务，请检查网络') }
    }
  }

  if (loading) {
    return <div className="memory-loading">{t('加载中…')}</div>
  }

  if (loadError) {
    return <div className="character-panel__error">{loadError}</div>
  }

  const isConfigured = (provider: KeyProvider): boolean =>
    keys[provider].fromEnv ? keys[provider].envDetected : keys[provider].hasKey

  const fromEnvs: Record<KeyProvider, boolean> = {
    anthropic: keys.anthropic.fromEnv,
    openai: keys.openai.fromEnv,
    deepseek: keys.deepseek.fromEnv,
  }

  const providerOptionsFor = (current: ProviderType): ProviderType[] => {
    const options: ProviderType[] = [...KEY_PROVIDERS.filter(isConfigured), 'ollama']
    return options.includes(current) ? options : [current, ...options]
  }

  return (
    <fieldset className="model-config-panel" disabled={saving}>
      <div className="model-config-panel__section">
        <div className="model-config-panel__section-label">{t('API Key')}</div>
        <KeyGroup
          provider="anthropic"
          summary={keys.anthropic}
          keyInput={keyInputs.anthropic}
          editing={keyEditing.anthropic}
          envError={envErrors.anthropic}
          onKeyInputChange={value => setKeyInputs(prev => ({ ...prev, anthropic: value }))}
          onEditingChange={editing => setKeyEditing(prev => ({ ...prev, anthropic: editing }))}
          onCommit={handleKeyCommit('anthropic')}
          onEnvChange={checked => void handleEnvChange('anthropic', checked)}
          onTest={() => testKey('anthropic')}
        />
        <KeyGroup
          provider="openai"
          summary={keys.openai}
          keyInput={keyInputs.openai}
          editing={keyEditing.openai}
          envError={envErrors.openai}
          onKeyInputChange={value => setKeyInputs(prev => ({ ...prev, openai: value }))}
          onEditingChange={editing => setKeyEditing(prev => ({ ...prev, openai: editing }))}
          onCommit={handleKeyCommit('openai')}
          onEnvChange={checked => void handleEnvChange('openai', checked)}
          onTest={() => testKey('openai')}
        />
        <KeyGroup
          provider="deepseek"
          summary={keys.deepseek}
          keyInput={keyInputs.deepseek}
          editing={keyEditing.deepseek}
          envError={envErrors.deepseek}
          onKeyInputChange={value => setKeyInputs(prev => ({ ...prev, deepseek: value }))}
          onEditingChange={editing => setKeyEditing(prev => ({ ...prev, deepseek: editing }))}
          onCommit={handleKeyCommit('deepseek')}
          onEnvChange={checked => void handleEnvChange('deepseek', checked)}
          onTest={() => testKey('deepseek')}
        />
      </div>

      <div className="model-config-panel__section">
        <OllamaUrlField saved={form.ollamaBaseUrl} onCommit={saveOllamaUrl} onTest={() => testKey('ollama')} />
      </div>

      <SubscriptionLogin />

      <div className="model-config-panel__section">
        <div className="model-config-panel__section-label">{t('对话模型')}</div>
        <ModelSelectionFields
          selection={form.chat}
          providerOptions={providerOptionsFor(form.chat.type)}
          reloadKey={modelsReloadKey}
          fromEnvs={fromEnvs}
          onChange={chat => {
            setForm(prev => ({ ...prev, chat }))
            setItemErrors(prev => ({ ...prev, chat: null }))
          }}
          onCommit={next => void saveChat(next)}
        />
        {itemErrors.chat !== null && <div className="character-panel__error">{itemErrors.chat}</div>}
        <div className="model-config-panel__field model-config-panel__field--short">
          <label htmlFor={maxTokensId}>{t('最大回复 token 数（max_tokens）')}</label>
          <input
            id={maxTokensId}
            type="number"
            min={MIN_MAX_TOKENS}
            max={MAX_MAX_TOKENS}
            step={1}
            placeholder={t('默认 1000')}
            value={form.maxTokens}
            onChange={e => {
              setForm(prev => ({ ...prev, maxTokens: e.target.value }))
              setItemErrors(prev => ({ ...prev, maxTokens: null }))
            }}
            onBlur={handleMaxTokensBlur}
          />
          <span className="model-config-panel__inline-hint">{t('Ollama 不受此限制')}</span>
        </div>
        {itemErrors.maxTokens !== null && <div className="character-panel__error">{itemErrors.maxTokens}</div>}
      </div>

      <div className="model-config-panel__section">
        <div className="model-config-panel__section-label">{t('摘要模型')}</div>
        <label className="model-config-panel__checkbox">
          <input
            type="checkbox"
            checked={form.sameAsChat}
            onChange={e => handleSameAsChatChange(e.target.checked)}
          />
          {t('使用与对话模型相同')}
        </label>
        {!form.sameAsChat && (
          <>
            <ModelSelectionFields
              selection={form.summary}
              providerOptions={providerOptionsFor(form.summary.type)}
              reloadKey={modelsReloadKey}
              fromEnvs={fromEnvs}
              onChange={summary => {
                setForm(prev => ({ ...prev, summary }))
                setItemErrors(prev => ({ ...prev, summary: null }))
              }}
              onCommit={next => void saveSummary({ backgroundModelProvider: buildSelectionPatch(next) })}
            />
            {form.summary.type === 'ollama' && (
              <div className="character-panel__hint">{t('内容较多或较复杂的整理建议使用线上模型')}</div>
            )}
          </>
        )}
        {itemErrors.summary !== null && <div className="character-panel__error">{itemErrors.summary}</div>}
      </div>
    </fieldset>
  )
}
