// src/chat/mergeAfterForget.ts — 时间段删除后用最新一页历史替换消息列表，并按原顺序保留尚未得到回复的本地用户消息
// 用法：ChatWindow 因 messages-forgotten 或点击加载失败提示旁的刷新按钮而重新取到最新一页后调 mergeAfterForget(page, current, pendingIds)
// 对应文件：src/chat/ChatWindow.tsx / src/chat/MessageBubble.tsx / src/chat/mergeAfterForget.test.ts
import type { MessageData } from './MessageBubble'

export function mergeAfterForget(
  page: MessageData[],
  current: MessageData[],
  pendingIds: ReadonlySet<string>,
): MessageData[] {
  return [...page, ...current.filter(m => pendingIds.has(m.id))]
}
