// src/settings/CharacterPanel.tsx — 设置窗口的"角色"页：角色名与重命名、角色素材包、一键生成角色配置、创建/导入角色、删除角色
// 用法：SettingsApp 渲染 <CharacterPanel panel={useCharacterPanel 的返回值} />
// 形状：props { panel: CharacterPanelModel }
// 对应文件：src/settings/SettingsApp.tsx / src/settings/useCharacterPanel.ts / src/settings/VoiceEnrollProgress.tsx / src/settings/RoleConfigStepRow.tsx
import React from 'react'
import { useTranslation } from 'react-i18next'
import type { CharacterPanelModel } from './useCharacterPanel'
import { VoiceEnrollProgress } from './VoiceEnrollProgress.js'
import { RoleConfigStepRow, type RoleConfigRowState } from './RoleConfigStepRow.js'

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
    roleConfigComplete, roleConfigCompleteFailed, roleConfigReadInterrupted, roleConfigReadStarting,
    roleConfigReadings, roleConfigTranscripts, roleConfigCurrent, handleRoleConfigRerecord, handleRoleConfigContinue,
    handleRoleConfigFinish,
    roleConfigPluginKind, roleConfigVoiceDone, roleConfigReadChoice, roleConfigSynthReady, handleRoleConfigReadEnter,
    handleRoleConfigReadSkip, handleRoleConfigReadSkipConfirm, handleRoleConfigGreet,
    roleConfigEnrollAsk, roleConfigEnrolling, roleConfigEnrollBusy, roleConfigEnrollInterrupted, roleConfigEnrollError, roleConfigVoice,
    handleRoleConfigEnrollStart, handleRoleConfigEnrollCommit, handleRoleConfigEnrollCancel, handleRoleConfigEnrollSkip,
  } = panel
  const roleConfigBusy = roleConfigStatus === 'looking' || roleConfigStatus === 'choosing' || roleConfigStatus === 'naming' || roleConfigStatus === 'saving'
    || roleConfigStatus === 'collecting' || roleConfigStatus === 'reading' || roleConfigStatus === 'finishing'
  const roleConfigSaving = roleConfigStatus === 'saving'
  const roleName = presetSnapshot?.name ?? ''
  const groupState = (children: (RoleConfigRowState | undefined)[]): RoleConfigRowState | undefined => {
    if (children.includes('failed')) return 'failed'
    if (children.every(state => state === 'done')) return 'done'
    return children.some(state => state !== undefined) ? 'start' : undefined
  }
  const voiceEnhanceState: RoleConfigRowState | undefined = roleConfigSteps.synthesize === 'failed'
    ? 'failed'
    : roleConfigVoiceDone ? 'done' : roleConfigSteps.synthesize === undefined ? undefined : 'start'
  const pluginTexts = roleConfigPluginKind === 'check'
    ? { start: t('正在检查语音插件...'), done: t('语音插件检查完毕'), failed: t('语音插件检查失败') }
    : roleConfigPluginKind === 'update'
      ? { start: t('正在更新语音插件...'), done: t('语音插件更新已完成'), failed: t('语音插件更新失败') }
      : { start: t('正在安装语音插件...'), done: t('语音插件安装已完成'), failed: t('语音插件安装失败') }
  const synapseOne = [
    { key: 'search', state: roleConfigSteps.search, texts: { start: t('正在联网搜索...'), done: t('联网搜索已完成'), failed: t('联网搜索失败') } },
    { key: 'merge', state: roleConfigSteps.merge, texts: { start: t('正在整理信息...'), done: t('信息整理已完成'), failed: t('信息整理失败') } },
  ]
  const synapseTwo = [
    { key: 'voice', state: voiceEnhanceState, texts: { start: t('正在进行人声强化...'), done: t('人声强化已完成'), failed: t('人声强化失败') } },
    { key: 'analyze', state: roleConfigSteps.analyze, texts: { start: t('正在进行热词整理...'), done: t('热词整理已完成'), failed: t('热词整理失败') } },
    { key: 'write', state: roleConfigSteps.write, texts: { start: t('正在完成热词写入...'), done: t('热词写入已完成'), failed: t('热词写入失败') } },
  ]
  const synapseOneState = groupState(synapseOne.map(item => item.state))
  const synapseTwoState = groupState(synapseTwo.map(item => item.state))
  const roleConfigReadAsking = roleConfigStatus === 'collecting' && roleConfigSynthReady && !roleConfigEnrollAsk && roleConfigReadChoice !== 'enter'
  const roleConfigCandidates = roleConfigLookup?.kind === 'candidates' ? roleConfigLookup.candidates : []
  const roleConfigChosenCount = roleConfigNames.filter(item => item.selected).length
  const roleConfigAllRead = roleConfigTranscripts.length > 0 && !roleConfigTranscripts.includes(null)

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
            {roleConfigCompleteFailed ? (
              <span className="character-panel__error">{t('角色配置状态读取失败')}</span>
            ) : roleConfigComplete === null ? (
              <button className="rename-btn" disabled>
                {t('加载中…')}
              </button>
            ) : roleConfigComplete ? (
              <>
                <button className="rename-btn" disabled>
                  {t('角色已完整配置')}
                </button>
                <button className="rename-btn" onClick={handleRoleConfigStart} disabled={roleConfigBusy}>
                  {t('更新')}
                </button>
              </>
            ) : (
              <button className="rename-btn" onClick={handleRoleConfigStart} disabled={roleConfigBusy}>
                {t('一键生成角色配置')}
              </button>
            )}
            {roleConfigStatus === 'saved' && <span className="character-panel__name">{roleConfigSaved}</span>}
          </div>
          {Object.keys(roleConfigSteps).length > 0 && (
            <div className="character-panel__role-config-list">
              {roleConfigSteps.extract && (
                <RoleConfigStepRow
                  state={roleConfigSteps.extract}
                  texts={{
                    start: t('正在校验{{name}}信息...', { name: roleName }),
                    done: t('{{name}}信息校验已完成', { name: roleName }),
                    failed: t('{{name}}信息校验失败', { name: roleName }),
                  }}
                />
              )}
              {synapseOneState && (
                <>
                  <RoleConfigStepRow
                    state={synapseOneState}
                    texts={{ start: t('正在建立神经突触链接...'), done: t('已建立神经突触链接'), failed: t('神经突触链接建立失败') }}
                  />
                  {synapseOneState !== 'done' && synapseOne.map(item => item.state && (
                    <RoleConfigStepRow key={item.key} state={item.state} texts={item.texts} child />
                  ))}
                </>
              )}
              {roleConfigSteps.plugin && (
                <RoleConfigStepRow state={roleConfigSteps.plugin as RoleConfigRowState} texts={pluginTexts} />
              )}
              {synapseTwoState && (
                <>
                  <RoleConfigStepRow
                    state={synapseTwoState}
                    texts={{ start: t('正在强化神经突触链接...'), done: t('已强化神经突触链接'), failed: t('神经突触链接强化失败') }}
                  />
                  {synapseTwoState !== 'done' && synapseTwo.map(item => item.state && (
                    <RoleConfigStepRow key={item.key} state={item.state} texts={item.texts} child />
                  ))}
                </>
              )}
            </div>
          )}
          {roleConfigStatus === 'saved' && (
            <>
              <div className="character-panel__name">{t('✓ 与{{name}}链接同步已就绪', { name: roleName })}</div>
              <div className="character-panel__row">
                <button className="rename-btn" onClick={handleRoleConfigCancel}>
                  {t('完成')}
                </button>
                <button className="rename-btn" onClick={() => void handleRoleConfigGreet()}>
                  {t('打招呼')}
                </button>
              </div>
            </>
          )}
          {roleConfigReadAsking && (
            roleConfigReadChoice === 'pending' ? (
              <>
                <div className="character-panel__name">
                  {t('角色呼唤通道已建立。推荐录入个人呼唤：用你自己的声音念几句称呼，{{name}}会更准确地听出你在叫TA。建议在安静的室内录制，预计耗时 5~10 秒。', { name: roleName })}
                </div>
                <div className="character-panel__row">
                  <button className="rename-btn" onClick={handleRoleConfigReadEnter}>
                    {t('录入（推荐）')}
                  </button>
                  <button className="rename-btn" onClick={handleRoleConfigReadSkip}>
                    {t('跳过')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="character-panel__name">
                  {t('跳过后只用合成语音整理热词，{{name}}可能听不准你的呼唤。录入音频不会保留或上传，确定跳过吗？', { name: roleName })}
                </div>
                <div className="character-panel__row">
                  <button className="rename-btn" onClick={handleRoleConfigReadEnter}>
                    {t('去录入')}
                  </button>
                  <button className="rename-btn" onClick={() => void handleRoleConfigReadSkipConfirm()}>
                    {t('确定跳过')}
                  </button>
                </div>
              </>
            )
          )}
          {roleConfigEnrollAsk && roleConfigStatus === 'collecting' && (
            <>
              {roleConfigEnrolling ? (
                <VoiceEnrollProgress
                  speaker={roleConfigVoice?.speaker ?? null}
                  current={roleConfigVoice?.enroll.current ?? []}
                  completed={roleConfigVoice?.enroll.completed ?? []}
                  locked={roleConfigEnrollBusy}
                  onCommit={() => void handleRoleConfigEnrollCommit()}
                  onCancel={() => void handleRoleConfigEnrollCancel()}
                />
              ) : (
                <>
                  {roleConfigEnrollInterrupted && (
                    <div className="character-panel__error">
                      {t('录入时请勿切换输入设备，否则会显著降低对主人的识别准确率；本次录入已终止，原声纹继续使用。')}
                    </div>
                  )}
                  <div className="character-panel__name">{t('是否先录入声纹？')}</div>
                  <div className="character-panel__row">
                    <button
                      className="rename-btn"
                      onClick={() => void handleRoleConfigEnrollStart()}
                      disabled={roleConfigEnrollBusy || roleConfigVoice?.phase !== 'running'}
                    >
                      {t('录入')}
                    </button>
                    <button className="rename-btn" onClick={handleRoleConfigEnrollSkip} disabled={roleConfigEnrollBusy}>
                      {t('跳过')}
                    </button>
                  </div>
                </>
              )}
              {roleConfigEnrollError && <div className="character-panel__error">{roleConfigEnrollError}</div>}
            </>
          )}
          {(roleConfigStatus === 'looking' || roleConfigStatus === 'collecting' || roleConfigStatus === 'finishing') && (
            <div className="character-panel__row">
              <button className="rename-btn" onClick={handleRoleConfigCancel}>
                {t('返回')}
              </button>
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
          {roleConfigStatus === 'reading' && (
            <>
              <div className="character-panel__role-config-notice">
                <div className="character-panel__section-title">{t('录音须知')}</div>
                <ul>
                  <li>{t('请在安静的环境里录制，远离音乐、视频和其他人说话的声音')}</li>
                  <li>{t('用平时跟角色说话的语气和语速念，不用刻意放慢或咬字')}</li>
                  <li>{t('录制期间请不要切换麦克风或耳机')}</li>
                  <li>{t('每句念完、识别出来后，会自动跳到下一句')}</li>
                </ul>
              </div>
              {roleConfigCurrent >= 0 && (
                <div className="character-panel__hint">
                  {t('第 {{n}} / 共 {{total}} 句', { n: roleConfigCurrent + 1, total: roleConfigReadings.length })}
                </div>
              )}
              <ol className="character-panel__role-config-readings">
                {roleConfigReadings.map((reading, index) => {
                  const transcript = roleConfigTranscripts[index]
                  if (transcript !== null && transcript !== undefined) {
                    return (
                      <li key={index} className="character-panel__role-config-reading character-panel__role-config-reading--done">
                        <div className="character-panel__role-config-recorded">
                          <span>
                            <span>{reading.script}</span>
                            <span>{t('转写：{{text}}', { text: transcript })}</span>
                          </span>
                          <button className="rename-btn" onClick={() => handleRoleConfigRerecord(index)} disabled={roleConfigReadStarting}>
                            {t('重录')}
                          </button>
                        </div>
                      </li>
                    )
                  }
                  const isCurrent = index === roleConfigCurrent
                  return (
                    <li key={index} className={`character-panel__role-config-reading${isCurrent ? ' character-panel__role-config-reading--current' : ''}`}>
                      <div>{isCurrent ? `▶ ${reading.script}` : reading.script}</div>
                      {isCurrent && roleConfigReadInterrupted && (
                        <div className="character-panel__role-config-recorded">
                          <span className="character-panel__name">{t('朗读已中断，点\'继续\'从这一句接着念')}</span>
                          <button className="rename-btn" onClick={handleRoleConfigContinue} disabled={roleConfigReadStarting}>
                            {t('继续')}
                          </button>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ol>
              {roleConfigAllRead && (
                <div className="character-panel__role-config-recorded">
                  <span className="character-panel__name">{t('全部念完了。转写不对的句子可以点\'重录\'，确认后点\'下一步\'')}</span>
                  <button className="rename-btn" onClick={handleRoleConfigFinish}>
                    {t('下一步')}
                  </button>
                </div>
              )}
              <div className="character-panel__row">
                <button className="rename-btn" onClick={handleRoleConfigCancel}>
                  {t('返回')}
                </button>
              </div>
            </>
          )}
          {roleConfigError && (
            <div className="character-panel__row">
              <span className="character-panel__error">{roleConfigError}</span>
              {roleConfigStatus === 'error' && (
                <>
                  <button className="rename-btn" onClick={handleRoleConfigStart}>
                    {t('重试')}
                  </button>
                  <button className="rename-btn" onClick={handleRoleConfigCancel}>
                    {t('返回')}
                  </button>
                </>
              )}
              {roleConfigStatus === 'failed' && (
                <button className="rename-btn" onClick={handleRoleConfigCancel}>
                  {t('返回')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {characterError && !isCreating && <div className="character-panel__error">{characterError}</div>}
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
      <div className="character-panel__create-zone">
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
            {characterError && <div className="character-panel__error">{characterError}</div>}
          </div>
        )}
      </div>
    </div>
  )
}
