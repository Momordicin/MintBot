import { getPendingSummaryMessages, insertSummaryAndMarkMessages } from '../session/queries.js'
import type { Message, BuiltContext, CompletionOptions } from '../../../shared/types/index.js'
import { getMemoryConfig } from '../config/index.js'

export interface SummaryModelProvider {
  completeSync(context: BuiltContext, options?: CompletionOptions): Promise<string>
}

export function shouldTriggerSummary(input: {
  messageCountSinceLastSummary: number
  lockScreenMinutes: number
  isLowActivityWindow: boolean
}): boolean {
  const { messageCountSinceLastSummary, lockScreenMinutes, isLowActivityWindow } = input
  const { lockScreenMinutes: lockScreenMinutesThreshold, messageCountThreshold, minMessagesForLockTrigger } = getMemoryConfig().summaryTrigger
  const lowActivityAndLocked =
    isLowActivityWindow &&
    lockScreenMinutes > lockScreenMinutesThreshold &&
    messageCountSinceLastSummary >= minMessagesForLockTrigger
  const tooManyMessages = messageCountSinceLastSummary > messageCountThreshold
  return lowActivityAndLocked || tooManyMessages
}

function buildSummaryContext(messages: Message[]): BuiltContext {
  const messagesText = messages.map(m => `[${m.role}] ${m.content}`).join('\n')

  const system = [
    '你是一个对话摘要助手，请把以下对话压缩为简洁摘要，保留关键事实',
    '（如用户身份、偏好、重要事件、关系变化等）。',
    '直接输出摘要正文，不要包含任何其它说明文字或 markdown 代码块标记。',
  ].join('\n')

  return {
    system,
    messages: [{ role: 'user', content: messagesText }],
  }
}

export async function generateSummary(
  sessionId: string,
  deps: { model: SummaryModelProvider },
  maxMessages = 200
): Promise<{ summaryId: number; fromMessageId: number; toMessageId: number } | null> {
  const pending = getPendingSummaryMessages(sessionId, maxMessages)
  if (pending.length === 0) return null

  const context = buildSummaryContext(pending)
  const content = await deps.model.completeSync(context)

  const fromMessageId = pending[0].id
  const toMessageId = pending[pending.length - 1].id
  const summaryId = insertSummaryAndMarkMessages({ sessionId, content, fromMessageId, toMessageId }, pending.map(m => m.id))

  return { summaryId, fromMessageId, toMessageId }
}
