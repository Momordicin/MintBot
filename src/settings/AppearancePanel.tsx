// src/settings/AppearancePanel.tsx — 设置窗口的"外观"页：壁纸、桌宠形态、主题模式与强调色、染色强度、聊天背景不透明度、主题预览
// 用法：SettingsApp 渲染 <AppearancePanel panel={useCharacterPanel 的返回值} />
// 形状：props { panel: CharacterPanelModel }
// 对应文件：src/settings/SettingsApp.tsx / src/settings/useCharacterPanel.ts / src/settings/themeControls.ts / shared/portraitForm.ts
import React from 'react'
import { useTranslation } from 'react-i18next'
import type { PresetDisplayConfig } from '../../shared/types/index.js'
import { rgbToHex, tintStrengthToPercent } from './themeControls.js'
import type { CharacterPanelModel } from './useCharacterPanel'

interface AppearancePanelProps {
  panel: CharacterPanelModel
}

export function AppearancePanel({ panel }: AppearancePanelProps) {
  const { t } = useTranslation()
  const portraitFormLabels: Record<PresetDisplayConfig['currentPortrait'], string> = {
    pixel: t('像素'),
    illustration: t('立绘'),
  }
  const {
    presetSnapshot, presets, appearanceError, deleteTarget, isDeleting, isUploadingWallpaper, isSwitchingPortrait,
    portraitForms, canSwitchPortrait, otherPortrait, effectivePortrait, chatBgOpacity, themeMode, accentRgb,
    tintStrength, previewResolvedMode, previewVars, previewWallpaperUrl, handleWallpaperPick, handlePortraitToggle,
    handleNoColorClick, handleOpacityChange, handleThemeModeChange, handleAccentColorChange, handleTintChange,
    handleResetTint,
  } = panel

  return (
    <div className="character-panel">
      {presets.length > 0 && (
        <>
          <div className="character-panel__section-title">{t('壁纸与形态')}</div>
          <div className="character-panel__row">
            <button
              className="wallpaper-btn"
              onClick={handleWallpaperPick}
              disabled={isUploadingWallpaper || deleteTarget !== null || isDeleting}
            >
              {isUploadingWallpaper ? t('更换中…') : t('更换壁纸')}
            </button>
            <button
              className="rename-btn"
              onClick={handlePortraitToggle}
              disabled={!canSwitchPortrait || isSwitchingPortrait || deleteTarget !== null || isDeleting}
              title={portraitForms !== null && !canSwitchPortrait
                ? t('该角色没有{{form}}', { form: portraitFormLabels[otherPortrait] })
                : t('切换桌宠形态')}
            >
              {portraitFormLabels[effectivePortrait]}
            </button>
          </div>
          <div className="character-panel__section-title character-panel__section-title--divided">{t('主题')}</div>
          <div className="character-panel__row">
            <button
              type="button"
              className={`character-panel__no-color-btn${chatBgOpacity === 0 ? ' character-panel__no-color-btn--active' : ''}`}
              onClick={handleNoColorClick}
              title={t('无色（不透明度设为 0）')}
              aria-label={t('无色')}
              aria-pressed={chatBgOpacity === 0}
            />
            <label className="character-panel__display-label" title={t('聊天区域背景不透明度')}>
              {t('不透明度')}
              <input
                className="character-panel__opacity-input"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={chatBgOpacity}
                onChange={handleOpacityChange}
              />
            </label>
          </div>
          <div className="character-panel__row">
            <label className="character-panel__display-label" title={t('聊天窗口跟随日间/夜间，还是跟随系统外观')}>
              {t('模式')}
              <select value={themeMode} onChange={handleThemeModeChange}>
                <option value="day">{t('日间')}</option>
                <option value="night">{t('夜间')}</option>
                <option value="auto">{t('跟随系统')}</option>
              </select>
            </label>
            <label className="character-panel__display-label" title={t('主题强调色（唯一一个用户选的颜色，其余全部自动派生）')}>
              {t('强调色')}
              <input
                className="character-panel__color-input"
                type="color"
                value={rgbToHex(accentRgb)}
                onChange={handleAccentColorChange}
              />
            </label>
          </div>
          <div className="character-panel__row">
            <label className="character-panel__display-label" title={t('强调色向中性表面/文字染色的强度，0 = 基准配色')}>
              {t('染色强度')}
              <input
                className="character-panel__opacity-input"
                type="range"
                min={0}
                max={100}
                step={1}
                value={tintStrengthToPercent(tintStrength)}
                onChange={handleTintChange}
              />
            </label>
            <button
              type="button"
              className="rename-btn"
              onClick={handleResetTint}
              disabled={tintStrength === 0}
              title={t('把染色强度重置为 0，恢复逐字节等于参考发布值的配色')}
            >
              {t('回到基准配色')}
            </button>
          </div>
          <div className="character-panel__theme-preview-wrap">
            <div className="character-panel__theme-preview-label">
              {t('主题预览')}
              {themeMode === 'auto' && (
                <span className="character-panel__theme-preview-resolved">
                  {previewResolvedMode === 'night' ? t('（当前跟随系统解析为夜间）') : t('（当前跟随系统解析为日间）')}
                </span>
              )}
            </div>
            <div
              className="character-panel__theme-preview"
              style={{
                backgroundImage: `url(${previewWallpaperUrl})`,
                ...previewVars,
              } as React.CSSProperties}
            >
              <div className="character-panel__theme-preview-titlebar">
                {presetSnapshot?.name ?? t('角色')}
              </div>
              <div className="character-panel__theme-preview-messages">
                <div className="character-panel__theme-preview-bubble character-panel__theme-preview-bubble--user">
                  {t('你好呀')}
                </div>
                <div className="character-panel__theme-preview-bubble character-panel__theme-preview-bubble--bot">
                  {t('嗯，在的')}
                </div>
                <div className="character-panel__theme-preview-timestamp">14:32</div>
              </div>
              <div className="character-panel__theme-preview-input">{t('输入消息…')}</div>
            </div>
          </div>
        </>
      )}
      {appearanceError && <div className="character-panel__error">{appearanceError}</div>}
    </div>
  )
}
