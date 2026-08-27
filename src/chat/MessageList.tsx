import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MessageBubble, MessageData } from './MessageBubble'
import { TypingIndicator } from './TypingIndicator'

// 距顶部小于这个阈值时视为"滑到顶部"，触发加载更多历史消息
const LOAD_MORE_SCROLL_THRESHOLD = 40

interface MessageListProps {
  messages: MessageData[]
  isReplying: boolean
  avatarUrl?: string
  userAvatarUrl?: string
  displayName?: string
  // 是否还有更多历史消息可加载；决定滑到顶部时是否触发 onLoadMore
  hasMoreHistory?: boolean
  onLoadMore?: () => void
  // 每次递增触发一次性滚动到底部（初始历史加载完成后使用），不影响新消息追加时
  // "不自动滚动"的既有行为
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
  // 触发 onLoadMore 前记录的 scrollHeight，用于新消息（更早的历史）prepend 渲染完后
  // 补偿 scrollTop，避免内容插入顶部造成的视觉跳动。只在触发加载更多时设置，
  // 新消息在底部追加时保持为 null，不影响现有"不自动滚动"行为
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
    // 不自动滚动，用户手动控制
  }, [messages])

  // 历史消息 prepend 渲染完成后，用 scrollHeight 差值补偿 scrollTop，让用户视觉上停在
  // 原来看的位置。用"最早一条消息的 id 是否变化"判断这次 messages 变化是不是一次 prepend
  // （而不是底部追加新消息），避免误伤上面"不自动滚动"的既有行为
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

  // 初始历史加载完成后滚动到底部一次，保证打开窗口时看到的是最新消息
  useEffect(() => {
    if (scrollToBottomSignal === undefined) return
    bottomRef.current?.scrollIntoView()
  }, [scrollToBottomSignal])

  // 容器内容不够多时（比如初始只加载 3 条短消息）没有溢出，也就没有可滚动区域——
  // 用户物理上"滑不出空间"来触发 handleScroll，即使 hasMoreHistory 为 true 也永远够不到。
  // 这里主动补一次：内容还没撑满容器、且确实还有更多历史时，直接触发 onLoadMore，不等用户
  // 先滑出空间。onLoadMore 本身在 ChatWindow 里有 isLoadingMoreRef 去重，这里重复调用是安全的；
  // 每次 messages 变化后重新判断，直到内容撑满容器（可以滚动了）或历史加载完（hasMoreHistory 为
  // false）为止，自然终止，不会死循环
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
