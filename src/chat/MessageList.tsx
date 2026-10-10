// src/chat/MessageList.tsx — 聊天窗口的消息滚动列表：渲染气泡与"正在回复"指示，滚到顶部附近或内容未铺满容器时请求更早历史并保持滚动位置，离底部较远时显示回到底部按钮
// 用法：ChatWindow 渲染 <MessageList />（以 sessionId 作 key）；scrollToBottomSignal 变化时滚到底部
// 形状：props { messages, isReplying, avatarUrl?, userAvatarUrl?, displayName?, hasMoreHistory?, onLoadMore?, scrollToBottomSignal? }
// 对应文件：src/chat/ChatWindow.tsx / src/chat/MessageBubble.tsx / src/chat/TypingIndicator.tsx
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MessageBubble, MessageData } from './MessageBubble'
import { TypingIndicator } from './TypingIndicator'

const LOAD_MORE_SCROLL_THRESHOLD = 40

interface MessageListProps {
  messages: MessageData[]
  isReplying: boolean
  avatarUrl?: string
  userAvatarUrl?: string
  displayName?: string
  hasMoreHistory?: boolean
  onLoadMore?: () => void
  scrollToBottomSignal?: number
}

export function MessageList({
  messages,
  isReplying,
  avatarUrl,
  userAvatarUrl,
  displayName,
  hasMoreHistory,
  onLoadMore,
  scrollToBottomSignal,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const pendingScrollAdjustRef = useRef<number | null>(null)
  const prevFirstIdRef = useRef<string | undefined>(messages[0]?.id)

  function scrollToBottom() {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  function handleScroll() {
    const el = containerRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setShowScrollBtn(distFromBottom > 80)

    if (hasMoreHistory && onLoadMore && el.scrollTop < LOAD_MORE_SCROLL_THRESHOLD) {
      pendingScrollAdjustRef.current = el.scrollHeight
      onLoadMore()
    }
  }

  useEffect(() => {
  }, [messages])

  useLayoutEffect(() => {
    const currentFirstId = messages[0]?.id
    if (pendingScrollAdjustRef.current !== null && currentFirstId !== prevFirstIdRef.current) {
      const el = containerRef.current
      if (el) {
        el.scrollTop += el.scrollHeight - pendingScrollAdjustRef.current
      }
      pendingScrollAdjustRef.current = null
    }
    prevFirstIdRef.current = currentFirstId
  }, [messages])

  useEffect(() => {
    if (scrollToBottomSignal === undefined) return
    bottomRef.current?.scrollIntoView()
  }, [scrollToBottomSignal])

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || !hasMoreHistory || !onLoadMore) return
    if (el.scrollHeight <= el.clientHeight) {
      onLoadMore()
    }
  }, [messages, hasMoreHistory, onLoadMore])

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
