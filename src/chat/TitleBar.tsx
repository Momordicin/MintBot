import React from 'react'

interface TitleBarProps {
  avatarUrl?: string
  displayName: string
}

// Window Controls Overlay 自绘标题栏（TDD §3.7 附「聊天窗口 chrome 模型」，批次一）。
// 底色/文字色由 --titlebar-bg / --titlebar-text 两个 CSS 变量控制（chat.css），
// 由 ChatWindow.tsx 按 displayConfig（accentRgb/themeMode/tintStrength，经 theme.ts
// deriveTheme）动态下发，本组件自己不需要接收颜色 props。
export function TitleBar({ avatarUrl, displayName }: TitleBarProps) {
  return (
    // 整个容器可拖动移动窗口；日后若在标题栏加可点击元素，必须给它加
    // -webkit-app-region: no-drag，否则点击会被当成拖动吞掉
    <div className="chat-titlebar">
      <div className="chat-titlebar__avatar">
        {avatarUrl
          ? <img src={avatarUrl} alt={displayName} />
          : <div className="chat-titlebar__avatar-placeholder" />}
      </div>
      <span className="chat-titlebar__name">{displayName}</span>
    </div>
  )
}
