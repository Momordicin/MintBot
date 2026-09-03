import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ModelConfig } from '../../shared/types/index.js'
import './settings.css'

const CORE_URL = 'http://127.0.0.1:3000'

// GET/PATCH /config/model 的响应类型：只取本面板展示需要的字段，本地重复定义
// （同 memory 子面板对 ForgetImpact/ForgetResult 等后端响应类型的约定），不从
// services/core 反向导入路由文件里的类型
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
}

interface ConfigModelResponse {
  modelProvider: ModelConfigSummary | null
  backgroundModelProvider: ModelConfigSummary | null
}

// 表单本地编辑状态：apiKey 永远不从服务端响应回填（决定 B——服务端从不回传明文 key），
// 空字符串代表"用户没有输入新值"，保存时据此决定要不要把这个字段带进 PATCH body
interface ModelFormState {
  type: 'anthropic' | 'openai' | 'ollama' | 'deepseek'
  apiKey: string
  modelName: string
  openaiBaseUrl: string
  deepseekBaseUrl: string
  ollamaBaseUrl: string
  ollamaModel: string
}

const BLANK_FORM: ModelFormState = {
  type: 'anthropic',
  apiKey: '',
  modelName: '',
  openaiBaseUrl: '',
  deepseekBaseUrl: '',
  ollamaBaseUrl: '',
  ollamaModel: '',
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
  }
}

// 把表单值转成 PATCH body 里的 Partial<ModelConfig>：modelName/openaiBaseUrl/ollamaBaseUrl/
// ollamaModel 都是从 GET 响应直接回填的明文字段（非密钥），按表单当前值原样带上；只有
// apiKey 是决定 B 特殊处理的字段——留空代表未修改，不进入 body，避免覆盖已存的 key
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
            // 切换供应商类型时清空 apiKey/modelName——否则用户在切换前已经输入的一个
            // provider 的密钥/模型名会被原样带到另一个 provider 下提交，buildPartialConfig
            // 无法区分"这个值是特意为新 type 填的"还是"切换前遗留下来的"
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

// 全局单例配置面板：不像 CharacterPanel 那样存在"切换 preset 导致响应姗姗来迟"的竞态
// （没有别的东西能并发地把这份配置"切换走"），因此只需要一个 AbortController 供卸载时
// abort 在途的 PATCH，不需要 presetSnapshotRef 那类一致性检查
export function ModelConfigPanel() {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [chatSummary, setChatSummary] = useState<ModelConfigSummary | null>(null)
  const [backgroundSummary, setBackgroundSummary] = useState<ModelConfigSummary | null>(null)
  const [chatForm, setChatForm] = useState<ModelFormState>(BLANK_FORM)
  // 摘要模型响应为 null 就代表"没有配置覆盖，跟随对话模型"——勾选框的初始状态直接映射这个原始值
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
        // 400 校验错误体是 { error: string }，把具体原因展示给用户而不是一个笼统的 HTTP 状态码
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
