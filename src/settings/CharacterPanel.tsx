// src/settings/CharacterPanel.tsx — 设置窗口的"角色"页：角色名与重命名、角色素材包、一键生成角色配置、创建/导入角色、删除角色
// 用法：SettingsApp 渲染 <CharacterPanel panel={useCharacterPanel 的返回值} />
// 形状：props { panel: CharacterPanelModel }
// 对应文件：src/settings/SettingsApp.tsx / src/settings/useCharacterPanel.ts
import React from 'react'
import { useTranslation } from 'react-i18next'
import type { CharacterPanelModel } from './useCharacterPanel'

interface CharacterPanelProps {
  panel: CharacterPanelModel
}

export function CharacterPanel({ panel }: CharacterPanelProps) {
  const { t } = useTranslation()
  const {
    presetSnapshot, presets, characterError, isRenaming, renameValue, setRenameValue, isSavingRename, renameInputWidth,
    presetNameRef, renameInputRef, deleteTarget, isDeleting, isSwitchingPreset, isCreating, createName, setCreateName,
    createCharacterId, setCreateCharacterId, createSystemPrompt, setCreateSystemPrompt, isSavingCreate, isImportingCard,
    isGeneratingSystemPrompt, importedCardFields, characterIdOptions, systemPromptStep, modelOverrideStep,
    isUploadingWallpaper, isSwitchingPortrait, handleRenameStart, handleRenameCancel, handleRenameSave,
    handleDeleteStart, handleDeleteCancel, handleDeleteConfirm, handleCreateStart, handleCreateCancel,
    handleImportCardPick, handleRegenerateSystemPrompt, handleCreateSave,
    roleConfigStatus, roleConfigLookup, roleConfigSelected, setRoleConfigSelected, roleConfigSteps, roleConfigMainName,
    roleConfigNames, roleConfigInput, setRoleConfigInput, roleConfigSaved, roleConfigError, handleRoleConfigStart,
    handleRoleConfigNext, handleRoleConfigPrevious, handleRoleConfigCancel, handleRoleConfigToggleName,
    handleRoleConfigAddNames, handleRoleConfigConfirm,
  } = panel
  const roleConfigBusy = roleConfigStatus === 'looking' || roleConfigStatus === 'choosing' || roleConfigStatus === 'naming' || roleConfigStatus === 'saving'
  const roleConfigSaving = roleConfigStatus === 'saving'
  const roleConfigStepRows = [
    { step: 'extract' as const, label: t('从人设抽名字') },
    { step: 'search' as const, label: t('联网搜索') },
    { step: 'merge' as const, label: t('整理备选项') },
  ]
  const roleConfigCandidates = roleConfigLookup?.kind === 'candidates' ? roleConfigLookup.candidates : []
  const roleConfigChosenCount = roleConfigNames.filter(item => item.selected).length

  return (
    <div className="character-panel">
      {presets.length > 0 && (
        <div className="character-panel__row">
          <span className="character-panel__field-label">{t('名称')}</span>
          {isRenaming ? (
            <input
              ref={renameInputRef}
              aria-label={t('名称')}
              className="character-panel__rename-input"
              style={renameInputWidth ? { width: renameInputWidth } : undefined}
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onKeyDown={e => {
                if (isSavingRename || e.nativeEvent.isComposing) return
                if (e.key === 'Enter') handleRenameSave()
                else if (e.key === 'Escape') handleRenameCancel()
              }}
              disabled={isSavingRename}
            />
          ) : (
            <span ref={presetNameRef} className="character-panel__name">{presetSnapshot?.name}</span>
          )}
          {isRenaming ? (
            <>
              <button className="rename-btn" onClick={handleRenameCancel} disabled={isSavingRename}>
                {t('取消')}
              </button>
              <button className="rename-btn" onClick={handleRenameSave} disabled={isSavingRename}>
                {isSavingRename ? t('保存中…') : t('保存')}
              </button>
            </>
          ) : (
            <button className="rename-btn" onClick={handleRenameStart} disabled={deleteTarget !== null || isDeleting} title={t('重命名当前角色')}>
              {t('编辑')}
            </button>
          )}
        </div>
      )}
      {presets.length > 0 && (
        <div className="character-panel__row">
          <span className="character-panel__field-label">{t('角色素材包')}</span>
          <span className="character-panel__name">{presetSnapshot?.characterId}</span>
        </div>
      )}
      {presets.length > 0 && (
        <div className="character-panel__role-config">
          <div className="character-panel__row">
            <button className="rename-btn" onClick={handleRoleConfigStart} disabled={roleConfigBusy}>
              {t('一键生成角色配置')}
            </button>
            {roleConfigStatus === 'saved' && <span className="character-panel__name">{roleConfigSaved}</span>}
          </div>
          {Object.keys(roleConfigSteps).length > 0 && (
            <div className="character-panel__role-config-list">
              {roleConfigStepRows.map(({ step, label }) => {
                const state = roleConfigSteps[step]
                if (!state) return null
                const text = state === 'start' ? `● ${label}……` : state === 'done' ? `✓ ${label}` : `✗ ${label}`
                return (
                  <div key={step} className="character-panel__role-config-step">
                    <span className={state === 'failed' ? 'character-panel__error' : 'character-panel__name'}>{text}</span>
                  </div>
                )
              })}
            </div>
          )}
          {roleConfigStatus === 'choosing' && (
            <>
              <div className="character-panel__role-config-list">
                {roleConfigCandidates.map((candidate, index) => (
                  <label key={index} className="character-panel__role-config-option">
                    <input
                      type="radio"
                      name="role-config-candidate"
                      checked={roleConfigSelected === index}
                      onChange={() => setRoleConfigSelected(index)}
                    />
                    <span>
                      <span className="character-panel__name">
                        {[candidate.main_name, ...candidate.aliases.map(alias => alias.name)].join('、')}
                      </span>
                      <span className="character-panel__hint">{candidate.source_summary}</span>
                      {candidate.relation !== null && (
                        <span className="character-panel__hint">{t('关系：{{relation}}', { relation: candidate.relation })}</span>
                      )}
                    </span>
                  </label>
                ))}
                <label className="character-panel__role-config-option">
                  <input
                    type="radio"
                    name="role-config-candidate"
                    checked={roleConfigSelected === 'none'}
                    onChange={() => setRoleConfigSelected('none')}
                  />
                  <span>{t('都不是')}</span>
                </label>
              </div>
              <div className="character-panel__row">
                <button className="rename-btn" onClick={handleRoleConfigCancel}>
                  {t('返回')}
                </button>
                <button className="rename-btn" onClick={handleRoleConfigNext} disabled={roleConfigSelected === null}>
                  {t('下一步')}
                </button>
              </div>
            </>
          )}
          {(roleConfigStatus === 'naming' || roleConfigStatus === 'saving') && (
            <>
              {roleConfigLookup?.kind === 'names' && roleConfigLookup.failed && (
                <div className="character-panel__error">{t('角色部分配置自动生成失败，详情见日志')}</div>
              )}
              <div className="character-panel__name">
                {t('你想怎么称呼{{name}}（可多选）', { name: roleConfigMainName ?? presetSnapshot?.name ?? '' })}
              </div>
              <div className="character-panel__role-config-names">
                {roleConfigNames.map(item => (
                  <button
                    key={item.name}
                    className={`rename-btn${item.selected ? ' character-panel__name-btn--selected' : ''}`}
                    aria-pressed={item.selected}
                    onClick={() => handleRoleConfigToggleName(item.name)}
                    disabled={roleConfigSaving}
                  >
                    {item.name}
                  </button>
                ))}
              </div>
              <div className="character-panel__row">
                <input
                  className="character-panel__rename-input"
                  aria-label={t('添加')}
                  placeholder={t('角色名/别称/昵称')}
                  value={roleConfigInput}
                  onChange={e => setRoleConfigInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleRoleConfigAddNames()
                  }}
                  onBlur={handleRoleConfigAddNames}
                  disabled={roleConfigSaving}
                />
                <button className="rename-btn" onClick={handleRoleConfigAddNames} disabled={roleConfigSaving || roleConfigInput.trim() === ''}>
                  {t('添加')}
                </button>
              </div>
              <div className="character-panel__row">
                <button className="rename-btn" onClick={handleRoleConfigCancel} disabled={roleConfigSaving}>
                  {t('返回')}
                </button>
                {roleConfigCandidates.length >= 2 && (
                  <button className="rename-btn" onClick={handleRoleConfigPrevious} disabled={roleConfigSaving}>
                    {t('上一步')}
                  </button>
                )}
                <button className="rename-btn" onClick={handleRoleConfigConfirm} disabled={roleConfigSaving || (roleConfigChosenCount === 0 && roleConfigInput.trim() === '')}>
                  {roleConfigSaving ? t('保存中…') : t('保存')}
                </button>
              </div>
            </>
          )}
          {roleConfigError && (
            <div className="character-panel__row">
              <span className="character-panel__error">{roleConfigError}</span>
              {roleConfigStatus === 'error' && (
                <button className="rename-btn" onClick={handleRoleConfigStart}>
                  {t('重试')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      <div className="character-panel__row">
        {!isCreating && (
          <button className="rename-btn" onClick={handleCreateStart} disabled={isImportingCard || deleteTarget !== null || isDeleting}>
            {t('创建角色')}
          </button>
        )}
      </div>
      {presets.length === 0 && !isCreating && (
        <div className="character-panel__hint">{t('还没有角色，创建一个开始')}</div>
      )}
      {isCreating && (
        <div className="character-panel__create-form">
          <button
            className="rename-btn"
            onClick={handleImportCardPick}
            disabled={isSavingCreate || isImportingCard || isGeneratingSystemPrompt}
          >
            {isImportingCard ? t('导入中…') : t('导入角色卡配置')}
          </button>
          <input
            className="character-panel__rename-input"
            value={createName}
            onChange={e => setCreateName(e.target.value)}
            placeholder={t('角色名称')}
            aria-label={t('角色名称')}
            disabled={isSavingCreate || isImportingCard}
          />
          <select
            aria-label={t('角色素材包')}
            value={createCharacterId}
            onChange={e => setCreateCharacterId(e.target.value)}
            disabled={isSavingCreate || isImportingCard}
          >
            {characterIdOptions.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <textarea
            className="character-panel__persona-textarea"
            value={createSystemPrompt}
            onChange={e => setCreateSystemPrompt(e.target.value)}
            placeholder={t('人设正文')}
            aria-label={t('人设正文')}
            disabled={isSavingCreate || isImportingCard}
          />
          {importedCardFields && (
            <button
              className="rename-btn"
              onClick={handleRegenerateSystemPrompt}
              disabled={isSavingCreate || isImportingCard || isGeneratingSystemPrompt}
              title={t('用后台模型把角色卡字段改写成更连贯的人设正文')}
            >
              {isGeneratingSystemPrompt ? t('改写中…') : t('使用模型辅助改写')}
            </button>
          )}
          <div className="character-panel__row">
            <button className="rename-btn" onClick={handleCreateCancel} disabled={isSavingCreate || isImportingCard}>
              {t('取消')}
            </button>
            <button className="rename-btn" onClick={handleCreateSave} disabled={isSavingCreate || isImportingCard}>
              {isSavingCreate ? t('创建中…') : t('创建')}
            </button>
          </div>
        </div>
      )}
      {characterError && <div className="character-panel__error">{characterError}</div>}
      {presets.length > 0 && (
        <div className="character-panel__danger-zone">
          <div className="character-panel__row">
            <button
              className="rename-btn"
              onClick={handleDeleteStart}
              disabled={
                deleteTarget !== null || presets.length <= 1 || isRenaming || isCreating || isSavingRename || isSavingCreate ||
                isUploadingWallpaper || isSwitchingPortrait || isImportingCard || isGeneratingSystemPrompt ||
                systemPromptStep === 'saving' || modelOverrideStep === 'saving' || isSwitchingPreset
              }
            >
              {t('删除角色')}
            </button>
          </div>
          {deleteTarget && (
            <div className="character-panel__confirm-row">
              <span>{t('删除『{{name}}』？该角色的全部聊天记录和记忆都会删除，无法恢复。', { name: deleteTarget.name })}</span>
              <button className="rename-btn" onClick={handleDeleteCancel} disabled={isDeleting}>
                {t('取消')}
              </button>
              <button className="rename-btn" onClick={handleDeleteConfirm} disabled={isDeleting}>
                {isDeleting ? t('删除中…') : t('确认删除')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
