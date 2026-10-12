// src/settings/AppearancePanel.tsx — 设置窗口的"外观"页：壁纸、桌宠形态、主题模式与强调色、染色强度、聊天背景不透明度、主题预览
// 用法：SettingsApp 渲染 <AppearancePanel panel={useCharacterPanel 的返回值} />
// 形状：props { panel: CharacterPanelModel }
// 对应文件：src/settings/SettingsApp.tsx / src/settings/useCharacterPanel.ts / src/settings/themeControls.ts / shared/portraitForm.ts
import React from 'react'
import type { PresetDisplayConfig } from '../../shared/types/index.js'
import { rgbToHex, tintStrengthToPercent } from './themeControls.js'
import type { CharacterPanelModel } from './useCharacterPanel'

const PORTRAIT_FORM_LABELS: Record<PresetDisplayConfig['currentPortrait'], string> = {
  pixel: '像素',
  illustration: '立绘',
}

interface AppearancePanelProps {
  panel: CharacterPanelModel
}

export function AppearancePanel({ panel }: AppearancePanelProps) {
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
          <div className="character-panel__section-title">壁纸与形态</div>
          <div className="character-panel__row">
            <button
              className="wallpaper-btn"
              onClick={handleWallpaperPick}
              disabled={isUploadingWallpaper || deleteTarget !== null || isDeleting}
              title="更换壁纸"
            >
              {isUploadingWallpaper ? '更换中…' : '更换壁纸'}
            </button>
            <button
              className="rename-btn"
              onClick={handlePortraitToggle}
              disabled={!canSwitchPortrait || isSwitchingPortrait || deleteTarget !== null || isDeleting}
              title={portraitForms !== null && !canSwitchPortrait
                ? `该角色没有${PORTRAIT_FORM_LABELS[otherPortrait]}`
                : '切换桌宠形态'}
            >
              {PORTRAIT_FORM_LABELS[effectivePortrait]}
            </button>
          </div>
          <div className="character-panel__section-title character-panel__section-title--divided">主题</div>
          <div className="character-panel__row">
            <button
              type="button"
              className={`character-panel__no-color-btn${chatBgOpacity === 0 ? ' character-panel__no-color-btn--active' : ''}`}
              onClick={handleNoColorClick}
              title="无色（不透明度设为 0）"
              aria-label="无色"
              aria-pressed={chatBgOpacity === 0}
            />
            <label className="character-panel__display-label" title="聊天区域背景不透明度">
              不透明度
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
            <label className="character-panel__display-label" title="聊天窗口跟随日间/夜间，还是跟随系统外观">
              模式
              <select value={themeMode} onChange={handleThemeModeChange}>
                <option value="day">日间</option>
                <option value="night">夜间</option>
                <option value="auto">跟随系统</option>
              </select>
            </label>
            <label className="character-panel__display-label" title="主题强调色（唯一一个用户选的颜色，其余全部自动派生）">
              强调色
              <input
                className="character-panel__color-input"
                type="color"
                value={rgbToHex(accentRgb)}
                onChange={handleAccentColorChange}
              />
            </label>
          </div>
          <div className="character-panel__row">
            <label className="character-panel__display-label" title="强调色向中性表面/文字染色的强度，0 = 基准配色">
              染色强度
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
              title="把染色强度重置为 0，恢复逐字节等于参考发布值的配色"
            >
              回到基准配色
            </button>
          </div>
          <div className="character-panel__theme-preview-wrap">
            <div className="character-panel__theme-preview-label">
              主题预览
              {themeMode === 'auto' && (
                <span className="character-panel__theme-preview-resolved">
                  （当前跟随系统解析为{previewResolvedMode === 'night' ? '夜间' : '日间'}）
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
                {presetSnapshot?.name ?? '角色'}
              </div>
              <div className="character-panel__theme-preview-messages">
                <div className="character-panel__theme-preview-bubble character-panel__theme-preview-bubble--user">
                  你好呀
                </div>
                <div className="character-panel__theme-preview-bubble character-panel__theme-preview-bubble--bot">
                  嗯，在的
                </div>
                <div className="character-panel__theme-preview-timestamp">14:32</div>
              </div>
              <div className="character-panel__theme-preview-input">输入消息…</div>
            </div>
          </div>
        </>
      )}
      {appearanceError && <div className="character-panel__error">{appearanceError}</div>}
    </div>
  )
}
