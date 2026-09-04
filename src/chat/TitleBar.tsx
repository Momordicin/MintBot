import React from 'react'

interface TitleBarProps {
  avatarUrl?: string
  displayName: string
}

// Window Controls Overlay 自绘标题栏（TDD §3.7 附「聊天窗口 chrome 模型」，批次一）。
// 颜色由 chat.css 里的常量控制，不接 displayConfig——动态下发是批次二的事。
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
