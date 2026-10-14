// src/settings/PersonaModelPanel.tsx — 设置窗口的「人设与模型」页
// 用法：SettingsApp 渲染 <PersonaModelPanel panel={useCharacterPanel 的返回值} />
// 对应文件：src/settings/SettingsApp.tsx / src/settings/useCharacterPanel.ts / src/settings/ApiKeyField.tsx / src/settings/ModelNameField.tsx
import React from 'react'
import type { ModelConfig } from '../../shared/types/index.js'
import type { CharacterPanelModel } from './useCharacterPanel'
import { ApiKeyField, ENV_VAR } from './ApiKeyField.js'
import { ModelNameField } from './ModelNameField.js'

interface PersonaModelPanelProps {
  panel: CharacterPanelModel
}

export function PersonaModelPanel({ panel }: PersonaModelPanelProps) {
  const {
    presetSnapshot, presets, personaError, systemPromptStep, systemPromptValue, setSystemPromptValue,
    systemPromptNotice, modelOverrideStep, useGlobalModel, setUseGlobalModel, overrideModelType,
    overrideModelName, setOverrideModelName, handleOverrideModelTypeChange, overrideKeyProvider, overrideKeySummary,
    overrideEnvDetected, overrideFromEnv, overrideKeyInput, setOverrideKeyInput, overrideKeyEditing,
    setOverrideKeyEditing, handleOverrideFromEnvChange, overrideKeysReady, modelKeysStatus, envStatus, retryModelKeys,
    loadEnvDetected, modelOverrideNotice, handleSystemPromptEditStart, handleSystemPromptEditCancel, handleSystemPromptSaveClick,
    handleSystemPromptConfirmSaveCancel, handleSystemPromptConfirmSaveConfirm, handleSystemPromptConfirmApplyCancel,
    handleSystemPromptSend, handleModelOverrideEditStart, handleModelOverrideEditCancel,
    handleModelOverrideSaveClick, handleModelOverrideChooseApplyCancel, handleModelOverrideSend,
  } = panel

  return (
    <div className="character-panel">
      {presets.length > 0 && (
        <div className="character-panel__persona">
          <div className="character-panel__persona-label">人设</div>
          {systemPromptStep === 'idle' && (
            <>
              <div className="character-panel__persona-text">{presetSnapshot?.systemPrompt}</div>
              <button className="rename-btn" onClick={handleSystemPromptEditStart} title="编辑当前角色的人设">
                编辑
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
                <button className="rename-btn" onClick={handleSystemPromptEditCancel}>取消</button>
                <button className="rename-btn" onClick={handleSystemPromptSaveClick}>保存</button>
              </div>
            </>
          )}
          {systemPromptStep === 'confirmingSave' && (
            <div className="character-panel__persona-confirm">
              <div>确认要保存这次修改吗？这会覆写『{presetSnapshot?.name}』的人格设定。</div>
              <div className="character-panel__row">
                <button className="rename-btn" onClick={handleSystemPromptConfirmSaveCancel}>取消</button>
                <button className="rename-btn" onClick={handleSystemPromptConfirmSaveConfirm}>确认</button>
              </div>
            </div>
          )}
          {systemPromptStep === 'confirmingApply' && (
            <div className="character-panel__persona-confirm">
              <div>现在就应用，还是下次生效？</div>
              <div className="character-panel__row">
                <button className="rename-btn" onClick={handleSystemPromptConfirmApplyCancel}>取消</button>
                <button className="rename-btn" onClick={() => handleSystemPromptSend(false)}>下次生效</button>
                <button className="rename-btn" onClick={() => handleSystemPromptSend(true)}>立即应用</button>
              </div>
            </div>
          )}
          {systemPromptStep === 'saving' && (
            <div className="character-panel__persona-confirm">保存中…</div>
          )}
        </div>
      )}
      {presets.length > 0 && (
        <div className="character-panel__model">
          <div className="character-panel__model-label">模型</div>
          {modelOverrideStep === 'idle' && (
            <>
              <div className="character-panel__model-text">
                {presetSnapshot?.modelType === null
                  ? '使用全局默认模型'
                  : `${presetSnapshot?.modelType} / ${presetSnapshot?.modelName}`}
              </div>
              <button className="rename-btn" onClick={handleModelOverrideEditStart} title="编辑当前角色使用的模型">
                编辑
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
                使用全局默认模型
              </label>
              {!useGlobalModel && (
                <>
                  <div className="model-config-panel__field">
                    <label>类型</label>
                    <select
                      value={overrideModelType}
                      onChange={e => handleOverrideModelTypeChange(e.target.value as ModelConfig['type'])}
                    >
                      <option value="anthropic">Anthropic</option>
                      <option value="openai">OpenAI</option>
                      <option value="deepseek">DeepSeek</option>
                      <option value="ollama">Ollama</option>
                    </select>
                  </div>
                  {overrideKeyProvider && (
                    <div className="model-config-panel__group">
                      <ApiKeyField
                        summary={overrideKeySummary}
                        envDetected={overrideEnvDetected}
                        envVar={ENV_VAR[overrideKeyProvider]}
                        fromEnv={overrideFromEnv}
                        keyInput={overrideKeyInput}
                        editing={overrideKeyEditing}
                        onKeyInputChange={setOverrideKeyInput}
                        onEditingChange={setOverrideKeyEditing}
                        onFromEnvChange={handleOverrideFromEnvChange}
                        keyStatus={modelKeysStatus}
                        envStatus={envStatus}
                      />
                      {modelKeysStatus === 'error' && (
                        <div className="character-panel__row">
                          <span className="character-panel__error">读取 API Key 状态失败</span>
                          <button className="rename-btn" onClick={retryModelKeys}>重试</button>
                        </div>
                      )}
                      {envStatus === 'error' && (
                        <div className="character-panel__row">
                          <span className="character-panel__error">读取环境变量检测状态失败</span>
                          <button className="rename-btn" onClick={loadEnvDetected}>重试</button>
                        </div>
                      )}
                    </div>
                  )}
                  <ModelNameField
                    type={overrideModelType}
                    current={overrideModelName}
                    apiKey={overrideKeyProvider ? overrideKeyInput.trim() : ''}
                    presetId={presetSnapshot?.presetId}
                    fromEnv={overrideKeyProvider !== null ? overrideFromEnv : undefined}
                    onChange={setOverrideModelName}
                  />
                </>
              )}
              <div className="character-panel__row">
                <button className="rename-btn" onClick={handleModelOverrideEditCancel}>取消</button>
                <button className="rename-btn" onClick={handleModelOverrideSaveClick} disabled={!overrideKeysReady}>保存</button>
              </div>
            </>
          )}
          {modelOverrideStep === 'chooseApply' && (
            <div className="character-panel__persona-confirm">
              <div>现在就应用，还是下次生效？</div>
              <div className="character-panel__row">
                <button className="rename-btn" onClick={handleModelOverrideChooseApplyCancel}>取消</button>
                <button className="rename-btn" onClick={() => handleModelOverrideSend(false)}>下次生效</button>
                <button className="rename-btn" onClick={() => handleModelOverrideSend(true)}>立即应用</button>
              </div>
            </div>
          )}
          {modelOverrideStep === 'saving' && (
            <div className="character-panel__persona-confirm">保存中…</div>
          )}
        </div>
      )}
      {personaError && <div className="character-panel__error">{personaError}</div>}
      {systemPromptNotice && <div className="character-panel__notice">{systemPromptNotice}</div>}
      {modelOverrideNotice && <div className="character-panel__notice">{modelOverrideNotice}</div>}
    </div>
  )
}
