import React, { useEffect, useRef, useState } from 'react'
import { MessageBubble, MessageData } from './MessageBubble'
import { TypingIndicator } from './TypingIndicator'

interface MessageListProps {
  messages: MessageData[]
  isReplying: boolean
  avatarUrl?: string
  userAvatarUrl?: string
  displayName?: string
}

export function MessageList({
  messages,
  isReplying,
  avatarUrl,
  userAvatarUrl,
  displayName,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)

  function scrollToBottom() {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  function handleScroll() {
    const el = containerRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setShowScrollBtn(distFromBottom > 80)
  }

  useEffect(() => {
    // 不自动滚动，用户手动控制
  }, [messages])

  return (
    <div className="msg-list" ref={containerRef} onScroll={handleScroll}>
      <div className="msg-list__inner">
        {messages.map((msg, i) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            prevRole={i > 0 ? messages[i - 1].role : undefined}
            avatarUrl={avatarUrl}
            userAvatarUrl={userAvatarUrl}
            displayName={displayName}
          />
        ))}
        {isReplying && <TypingIndicator />}
        <div ref={bottomRef} />
      </div>

      {showScrollBtn && (
        <button className="scroll-btn" onClick={scrollToBottom} aria-label="跳转到最新消息">
          ⌄
        </button>
      )}
    </div>
  )
}
