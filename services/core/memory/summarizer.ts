import { getPendingSummaryMessages, insertSummaryAndMarkMessages } from '../session/queries.js'
import type { Message, BuiltContext, CompletionOptions } from '../../../shared/types/index.js'
import { getMemoryConfig } from '../config/index.js'

// 摘要触发规则 + 生成（TDD §3.8 摘要触发逻辑）。
// shouldTriggerSummary 只负责布尔逻辑本身：lockScreenMinutes / isLowActivityWindow 目前没有
// 真实数据源（Win32 锁屏监听是 Phase 3、时间窗口调度依赖 node-cron，package.json 尚未安装该依赖），
// 本模块不引入 node-cron、不做任何调度 / 定时器，调用方（未来的调度器）负责采集并喂入这些参数——
// 这是有意缩小的范围，不是遗漏。
//
// generateSummary 只负责"取一个 session 的待摘要消息 → 生成摘要文本 → 落库 + 标记"，
// 不负责触发时机判断，与 shouldTriggerSummary 的调用方分离。

// 主模型只需要 completeSync（非流式），单独定义窄接口便于测试注入假实现，
// 无需依赖 ModelProvider 类的私有字段（结构化类型无法用对象字面量满足含私有成员的类类型）
export interface SummaryModelProvider {
  completeSync(context: BuiltContext, options?: CompletionOptions): Promise<string>
}

// 示例默认规则（TDD §3.8）：(时间段 ∈ 低活跃时段 AND 锁屏时长 > 60min) OR 消息数 > 50
// 两个阈值来自独立 config 模块（memory.summaryTrigger.lockScreenMinutes / messageCountThreshold）
export function shouldTriggerSummary(input: {
  messageCountSinceLastSummary: number
  lockScreenMinutes: number
  isLowActivityWindow: boolean
}): boolean {
  const { messageCountSinceLastSummary, lockScreenMinutes, isLowActivityWindow } = input
  const { lockScreenMinutes: lockScreenMinutesThreshold, messageCountThreshold } = getMemoryConfig().summaryTrigger
  const lowActivityAndLocked = isLowActivityWindow && lockScreenMinutes > lockScreenMinutesThreshold
  const tooManyMessages = messageCountSinceLastSummary > messageCountThreshold
  return lowActivityAndLocked || tooManyMessages
}

// 参考 entityExtractor.ts 的 buildLayer3Context 风格：system 描述任务，user content 拼入待摘要消息
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

// maxMessages 与 embedQueue.ts 的 batchSize 同款默认值（200），避免一次性把过大的 backlog
// 塞进单次模型调用；超出的部分保持 summarized = 0，留给下次调用处理
export async function generateSummary(
  sessionId: string,
  deps: { model: SummaryModelProvider },
  maxMessages = 200
): Promise<{ summaryId: number; fromMessageId: number; toMessageId: number } | null> {
  const pending = getPendingSummaryMessages(sessionId, maxMessages)
  if (pending.length === 0) return null

  // 生成失败时直接向上抛出，不标记任何消息为 summarized，由调用方决定重试策略
  // （与 embedQueue.ts 的失败补偿思路一致：失败的批次保持原状，等待下次重试）
  const context = buildSummaryContext(pending)
  const content = await deps.model.completeSync(context, { maxTokens: 1000 })

  const fromMessageId = pending[0].id
  const toMessageId = pending[pending.length - 1].id
  // insertSummary + markMessagesSummarized 用事务包裹，避免两步之间进程崩溃产生中间态
  const summaryId = insertSummaryAndMarkMessages({ sessionId, content, fromMessageId, toMessageId }, pending.map(m => m.id))

  return { summaryId, fromMessageId, toMessageId }
}
