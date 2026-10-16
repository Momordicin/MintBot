// src/settings/CharacterPanel.tsx — 设置窗口的"角色"页：角色名与重命名、角色素材包、创建/导入角色、删除角色
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
  } = panel

  return (
    <div className="character-panel">
      {presets.length > 0 && (
        <div className="character-panel__row">
          <span className="character-panel__field-label">{t('名称')}</span>
          {isRenaming ? (
            <input
              ref={renameInputRef}
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
      <div className="character-panel__row">
        {!isCreating && (
          <button className="rename-btn" onClick={handleCreateStart} disabled={isImportingCard || deleteTarget !== null || isDeleting} title={t('创建新角色')}>
            {t('创建角色')}
          </button>
        )}
        {!isCreating && (
          <button className="rename-btn" onClick={handleImportCardPick} disabled={isImportingCard || deleteTarget !== null || isDeleting} title={t('导入角色卡')}>
            {isImportingCard ? t('导入中…') : t('导入角色卡')}
          </button>
        )}
      </div>
      {presets.length === 0 && !isCreating && (
        <div className="character-panel__hint">{t('还没有角色，创建一个开始')}</div>
      )}
      {isCreating && (
        <div className="character-panel__create-form">
          <input
            className="character-panel__rename-input"
            value={createName}
            onChange={e => setCreateName(e.target.value)}
            placeholder={t('角色名称')}
            disabled={isSavingCreate}
          />
          <select
            value={createCharacterId}
            onChange={e => setCreateCharacterId(e.target.value)}
            disabled={isSavingCreate}
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
            disabled={isSavingCreate}
          />
          {importedCardFields && (
            <button
              className="rename-btn"
              onClick={handleRegenerateSystemPrompt}
              disabled={isSavingCreate || isGeneratingSystemPrompt}
              title={t('用后台模型把角色卡字段改写成更连贯的人设正文')}
            >
              {isGeneratingSystemPrompt ? t('改写中…') : t('使用模型辅助改写')}
            </button>
          )}
          <div className="character-panel__row">
            <button className="rename-btn" onClick={handleCreateCancel} disabled={isSavingCreate}>
              {t('取消')}
            </button>
            <button className="rename-btn" onClick={handleCreateSave} disabled={isSavingCreate}>
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
              title={t('删除当前角色')}
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
