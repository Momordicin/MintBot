// src/settings/PersonaModelPanel.tsx — 设置窗口的「人设与模型」页
// 用法：SettingsApp 渲染 <PersonaModelPanel panel={useCharacterPanel 的返回值} />
// 对应文件：src/settings/SettingsApp.tsx / src/settings/useCharacterPanel.ts / src/settings/ApiKeyField.tsx / src/settings/ModelNameField.tsx
import React from 'react'
import { useTranslation } from 'react-i18next'
import type { ModelConfig } from '../../shared/types/index.js'
import type { CharacterPanelModel } from './useCharacterPanel'
import { ApiKeyField, ENV_VAR, type ApiKeyLoadStatus, type ApiKeySummary, type KeyProvider } from './ApiKeyField.js'
import { ModelNameField } from './ModelNameField.js'

interface PersonaModelPanelProps {
  panel: CharacterPanelModel
}

interface ModelRowProps {
  label: string
  type: ModelConfig['type']
  modelName: string
  presetId?: string
  purpose?: 'summary'
  keyProvider: KeyProvider | null
  keySummary: ApiKeySummary
  envDetected: boolean
  fromEnv: boolean
  keyInput: string
  keyEditing: boolean
  keyStatus: ApiKeyLoadStatus
  envStatus: ApiKeyLoadStatus
  onTypeChange: (type: ModelConfig['type']) => void
  onModelNameChange: (name: string) => void
  onKeyInputChange: (value: string) => void
  onKeyEditingChange: (editing: boolean) => void
  onFromEnvChange: (checked: boolean) => void
}

function ModelRow({
  label, type, modelName, presetId, purpose, keyProvider, keySummary, envDetected, fromEnv, keyInput, keyEditing,
  keyStatus, envStatus, onTypeChange, onModelNameChange, onKeyInputChange, onKeyEditingChange, onFromEnvChange,
}: ModelRowProps) {
  const { t } = useTranslation()
  return (
    <>
    <div className="model-config-panel__row">
      <span className="model-config-panel__row-label">{label}</span>
      <div className="model-config-panel__field model-config-panel__field--compact model-config-panel__field--provider">
        <select value={type} onChange={e => onTypeChange(e.target.value as ModelConfig['type'])}>
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
          <option value="deepseek">DeepSeek</option>
          <option value="ollama">Ollama</option>
        </select>
      </div>
      <ModelNameField
        compact
        type={type}
        current={modelName}
        apiKey={keyProvider ? keyInput.trim() : ''}
        presetId={presetId}
        purpose={purpose}
        fromEnv={keyProvider !== null ? fromEnv : undefined}
        onChange={onModelNameChange}
      />
      {keyProvider && (
        <ApiKeyField
          compact
          summary={keySummary}
          envDetected={envDetected}
          envVar={ENV_VAR[keyProvider]}
          fromEnv={fromEnv}
          keyInput={keyInput}
          editing={keyEditing}
          onKeyInputChange={onKeyInputChange}
          onEditingChange={onKeyEditingChange}
          onFromEnvChange={onFromEnvChange}
          keyStatus={keyStatus}
          envStatus={envStatus}
        />
      )}
    </div>
    {purpose === 'summary' && type === 'ollama' && (
      <div className="character-panel__hint">{t('内容较多或较复杂的整理建议使用线上模型')}</div>
    )}
    </>
  )
}

export function PersonaModelPanel({ panel }: PersonaModelPanelProps) {
  const { t } = useTranslation()
  const {
    presetSnapshot, presets, personaError, systemPromptStep, systemPromptValue, setSystemPromptValue,
    systemPromptNotice, modelOverrideStep, useGlobalModel, setUseGlobalModel, overrideModelType,
    overrideModelName, setOverrideModelName, handleOverrideModelTypeChange, overrideKeyProvider, overrideKeySummary,
    overrideEnvDetected, overrideFromEnv, overrideKeyInput, setOverrideKeyInput, overrideKeyEditing,
    setOverrideKeyEditing, handleOverrideFromEnvChange, overrideKeysReady, modelKeysStatus, envStatus, retryModelKeys,
    loadEnvDetected, summarySameAsChat, setSummarySameAsChat, summaryModelType, summaryModelName, setSummaryModelName,
    handleSummaryModelTypeChange, summaryKeyProvider, summaryKeySummary, summaryEnvDetected, summaryFromEnv,
    summaryKeyInput, setSummaryKeyInput, summaryKeyEditing, setSummaryKeyEditing, handleSummaryFromEnvChange, modelOverrideNotice, handleSystemPromptEditStart, handleSystemPromptEditCancel, handleSystemPromptSaveClick,
    handleSystemPromptConfirmSaveCancel, handleSystemPromptConfirmSaveConfirm, handleSystemPromptConfirmApplyCancel,
    handleSystemPromptSend, handleModelOverrideEditStart, handleModelOverrideEditCancel,
    handleModelOverrideSaveClick, handleModelOverrideChooseApplyCancel, handleModelOverrideSend,
  } = panel

  return (
    <div className="character-panel">
      {presets.length > 0 && (
        <div className="character-panel__persona">
          <div className="character-panel__persona-label">{t('人设')}</div>
          {systemPromptStep === 'idle' && (
            <>
              <div className="character-panel__persona-text">{presetSnapshot?.systemPrompt}</div>
              <button className="rename-btn" onClick={handleSystemPromptEditStart} title={t('编辑当前角色的人设')}>
                {t('编辑')}
              </button>
            </>
          )}
          {systemPromptStep === 'editing' && (
            <>
              <textarea
                className="character-panel__persona-textarea"
                value={systemPromptValue}
                onChange={e => setSystemPromptValue(e.target.value)}
              />
              <div className="character-panel__row">
                <button className="rename-btn" onClick={handleSystemPromptEditCancel}>{t('取消')}</button>
                <button className="rename-btn" onClick={handleSystemPromptSaveClick}>{t('保存')}</button>
              </div>
            </>
          )}
          {systemPromptStep === 'confirmingSave' && (
            <div className="character-panel__persona-confirm">
              <div>{t('确认要保存这次修改吗？这会覆写『{{name}}』的人格设定。', { name: presetSnapshot?.name })}</div>
              <div className="character-panel__row">
                <button className="rename-btn" onClick={handleSystemPromptConfirmSaveCancel}>{t('取消')}</button>
                <button className="rename-btn" onClick={handleSystemPromptConfirmSaveConfirm}>{t('确认')}</button>
              </div>
            </div>
          )}
          {systemPromptStep === 'confirmingApply' && (
            <div className="character-panel__persona-confirm">
              <div>{t('现在就应用，还是下次生效？')}</div>
              <div className="character-panel__row">
                <button className="rename-btn" onClick={handleSystemPromptConfirmApplyCancel}>{t('取消')}</button>
                <button className="rename-btn" onClick={() => handleSystemPromptSend(false)}>{t('下次生效')}</button>
                <button className="rename-btn" onClick={() => handleSystemPromptSend(true)}>{t('立即应用')}</button>
              </div>
            </div>
          )}
          {systemPromptStep === 'saving' && (
            <div className="character-panel__persona-confirm">{t('保存中…')}</div>
          )}
        </div>
      )}
      {presets.length > 0 && (
        <div className="character-panel__model">
          <div className="character-panel__model-label">{t('模型')}</div>
          {modelOverrideStep === 'idle' && (
            <>
              <div className="character-panel__model-text">
                {presetSnapshot?.modelType === null
                  ? t('使用全局默认模型')
                  : `${presetSnapshot?.modelType} / ${presetSnapshot?.modelName}`}
              </div>
              <button className="rename-btn" onClick={handleModelOverrideEditStart} title={t('编辑当前角色使用的模型')}>
                {t('编辑')}
              </button>
            </>
          )}
          {modelOverrideStep === 'editing' && (
            <>
              <label className="character-panel__model-checkbox">
                <input
                  type="checkbox"
                  checked={useGlobalModel}
                  onChange={e => setUseGlobalModel(e.target.checked)}
                />
                {t('使用全局默认模型')}
              </label>
              {!useGlobalModel && (
                <>
                  <ModelRow
                    label={t('对话模型')}
                    type={overrideModelType}
                    modelName={overrideModelName}
                    presetId={presetSnapshot?.presetId}
                    keyProvider={overrideKeyProvider}
                    keySummary={overrideKeySummary}
                    envDetected={overrideEnvDetected}
                    fromEnv={overrideFromEnv}
                    keyInput={overrideKeyInput}
                    keyEditing={overrideKeyEditing}
                    keyStatus={modelKeysStatus}
                    envStatus={envStatus}
                    onTypeChange={handleOverrideModelTypeChange}
                    onModelNameChange={setOverrideModelName}
                    onKeyInputChange={setOverrideKeyInput}
                    onKeyEditingChange={setOverrideKeyEditing}
                    onFromEnvChange={handleOverrideFromEnvChange}
                  />
                  <label className="character-panel__model-checkbox">
                    <input
                      type="checkbox"
                      checked={summarySameAsChat}
                      onChange={e => setSummarySameAsChat(e.target.checked)}
                    />
                    {t('摘要使用与对话模型相同')}
                  </label>
                  {!summarySameAsChat && (
                    <ModelRow
                      label={t('摘要模型')}
                      type={summaryModelType}
                      modelName={summaryModelName}
                      presetId={presetSnapshot?.presetId}
                      purpose="summary"
                      keyProvider={summaryKeyProvider}
                      keySummary={summaryKeySummary}
                      envDetected={summaryEnvDetected}
                      fromEnv={summaryFromEnv}
                      keyInput={summaryKeyInput}
                      keyEditing={summaryKeyEditing}
                      keyStatus={modelKeysStatus}
                      envStatus={envStatus}
                      onTypeChange={handleSummaryModelTypeChange}
                      onModelNameChange={setSummaryModelName}
                      onKeyInputChange={setSummaryKeyInput}
                      onKeyEditingChange={setSummaryKeyEditing}
                      onFromEnvChange={handleSummaryFromEnvChange}
                    />
                  )}
                  {(overrideKeyProvider || summaryKeyProvider) && modelKeysStatus === 'error' && (
                    <div className="character-panel__row">
                      <span className="character-panel__error">{t('读取 API Key 状态失败')}</span>
                      <button className="rename-btn" onClick={retryModelKeys}>{t('重试')}</button>
                    </div>
                  )}
                  {(overrideKeyProvider || summaryKeyProvider) && envStatus === 'error' && (
                    <div className="character-panel__row">
                      <span className="character-panel__error">{t('读取环境变量检测状态失败')}</span>
                      <button className="rename-btn" onClick={loadEnvDetected}>{t('重试')}</button>
                    </div>
                  )}
                </>
              )}
              <div className="character-panel__row">
                <button className="rename-btn" onClick={handleModelOverrideEditCancel}>{t('取消')}</button>
                <button className="rename-btn" onClick={handleModelOverrideSaveClick} disabled={!overrideKeysReady}>{t('保存')}</button>
              </div>
            </>
          )}
          {modelOverrideStep === 'chooseApply' && (
            <div className="character-panel__persona-confirm">
              <div>{t('现在就应用，还是下次生效？')}</div>
              <div className="character-panel__row">
                <button className="rename-btn" onClick={handleModelOverrideChooseApplyCancel}>{t('取消')}</button>
                <button className="rename-btn" onClick={() => handleModelOverrideSend(false)}>{t('下次生效')}</button>
                <button className="rename-btn" onClick={() => handleModelOverrideSend(true)}>{t('立即应用')}</button>
              </div>
            </div>
          )}
          {modelOverrideStep === 'saving' && (
            <div className="character-panel__persona-confirm">{t('保存中…')}</div>
          )}
        </div>
      )}
      {personaError && <div className="character-panel__error">{personaError}</div>}
      {systemPromptNotice && <div className="character-panel__notice">{systemPromptNotice}</div>}
      {modelOverrideNotice && <div className="character-panel__notice">{modelOverrideNotice}</div>}
    </div>
  )
}
