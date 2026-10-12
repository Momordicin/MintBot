// src/settings/PersonaModelPanel.tsx — 设置窗口的"人设与模型"页：当前角色的人设提示词编辑、预设级模型覆盖
// 用法：SettingsApp 渲染 <PersonaModelPanel panel={useCharacterPanel 的返回值} />
// 形状：props { panel: CharacterPanelModel }
// 对应文件：src/settings/SettingsApp.tsx / src/settings/useCharacterPanel.ts
import React from 'react'
import type { ModelConfig } from '../../shared/types/index.js'
import type { CharacterPanelModel } from './useCharacterPanel'

interface PersonaModelPanelProps {
  panel: CharacterPanelModel
}

export function PersonaModelPanel({ panel }: PersonaModelPanelProps) {
  const {
    presetSnapshot, presets, personaError, systemPromptStep, systemPromptValue, setSystemPromptValue,
    systemPromptNotice, modelOverrideStep, useGlobalModel, setUseGlobalModel, overrideModelType,
    setOverrideModelType, overrideModelName, setOverrideModelName, overrideModelNameOptions, isLoadingModelNames,
    modelOverrideNotice, handleSystemPromptEditStart, handleSystemPromptEditCancel, handleSystemPromptSaveClick,
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
                <div className="character-panel__row">
                  <select
                    value={overrideModelType}
                    onChange={e => {
                      setOverrideModelType(e.target.value as ModelConfig['type'])
                      setOverrideModelName('')
                    }}
                  >
                    <option value="anthropic">Anthropic</option>
                    <option value="openai">OpenAI</option>
                    <option value="deepseek">DeepSeek</option>
                    <option value="ollama">Ollama</option>
                  </select>
                  <select
                    value={overrideModelName}
                    onChange={e => setOverrideModelName(e.target.value)}
                    disabled={overrideModelNameOptions.length === 0}
                  >
                    {overrideModelNameOptions.length === 0 ? (
                      <option value="" disabled>
                        {isLoadingModelNames
                          ? '模型列表加载中…'
                          : overrideModelType === 'ollama' ? 'Ollama 未运行或无可用模型' : '模型列表为空'}
                      </option>
                    ) : (
                      overrideModelNameOptions.map(name => (
                        <option key={name} value={name}>{name}</option>
                      ))
                    )}
                  </select>
                </div>
              )}
              <div className="character-panel__row">
                <button className="rename-btn" onClick={handleModelOverrideEditCancel}>取消</button>
                <button className="rename-btn" onClick={handleModelOverrideSaveClick}>保存</button>
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
