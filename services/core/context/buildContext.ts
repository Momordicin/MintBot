import type { BuiltContext, ChatMessage, MessageEntity } from '../../../shared/types/index.js'
import { requireCurrentState, getHistory } from '../session/index.js'
import { shouldTriggerRetrieval, retrieveMemories } from '../memory/retrieval.js'
import { getEmotionState, getSummaries, getCurrentEntities } from '../session/queries.js'
import type { EmbeddingProvider } from '../providers/EmbeddingProvider.js'

// 双轨记忆边界（TDD §3.8）：近期轨道 = 最近 N 条 **且** 最近 M 分钟内的消息，取交集
// （数量和时间哪个先截断就停在那），不在近期轨道内的历史交给 retrieveMemories 走 RAG 召回。
//
// TODO(Phase 2 config module): 这两个值对应 config.example.json 的
// memory.recentTrackMaxMessages / memory.recentTrackMaxMinutes，独立的 config 模块
// （跨模块读取 + 热更新，TDD Phase 2 checklist）尚未抽出，这里暂时硬编码为过渡方案，
// 不是定案设计——config 模块落地后应改为从配置读取。
const RECENT_TRACK_LIMIT = 50
const RECENT_TRACK_WINDOW_MS = 30 * 60 * 1000

// 实体分组注入用：中文标签 + 固定展示顺序
const ENTITY_TYPE_LABELS: Record<MessageEntity['type'], string> = {
  person: '人物',
  event: '事件',
  preference: '偏好',
  place: '地点',
  other: '其他',
}
const ENTITY_TYPE_ORDER: MessageEntity['type'][] = ['person', 'event', 'preference', 'place', 'other']

export async function buildContext(
  userInput: string,
  deps: { embedding: EmbeddingProvider; signal?: AbortSignal }
): Promise<BuiltContext> {
  const { session, preset } = requireCurrentState()

  // getHistory 已按时间升序返回最近 N 条，30 分钟窗口过滤掉的必然是数组前缀，
  // 过滤后剩下的就是"最近 N 条 且 最近 M 分钟内"的交集
  const history = getHistory(RECENT_TRACK_LIMIT)
    .filter(m => m.createdAt >= Date.now() - RECENT_TRACK_WINDOW_MS)

  const messages: ChatMessage[] = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: userInput },
  ]

  let system = preset.systemPrompt  // Phase 2：在这里拼入摘要、RAG召回、情绪状态等

  // 情绪状态注入（TDD §3.9）：self 情绪驱动回复风格，维持语气连贯性。
  // 本地同步查询，无外部调用开销，不需要像 RAG 召回那样加触发门槛，每次都尝试注入。
  // perceived_user 在 Phase 2 阶段恒为 null，不处理。
  const emotion = getEmotionState(session.sessionId)
  if (emotion) {
    system = `${system}\n\n你当前的情绪状态是「${emotion.self.label}」，强度为 ${emotion.self.intensity}，请让回复的语气与这一情绪保持连贯。`
  }

  // 实体上下文注入（TDD §3.8"实体聚合"）：TDD 原文"实体聚合→情绪状态"描述的是 RAG 检索内部
  // 流程顺序，不是这里 system 字符串拼接顺序的强制要求；本次实现选择的拼接顺序是
  // 情绪→实体→摘要→RAG。本地同步查询，无外部调用开销，与情绪状态注入同样不加触发门槛，每次都尝试注入。
  // 当前先注入全部当前有效实体，不限制数量、不做裁剪——实体数量长期增长后可能需要限制/裁剪，
  // 是已知的后续风险，Phase 2 现阶段先不做。
  const entities = getCurrentEntities(session.sessionId)
  if (entities.length > 0) {
    const grouped = new Map<MessageEntity['type'], string[]>()
    for (const entity of entities) {
      const list = grouped.get(entity.type) ?? []
      list.push(entity.value)
      grouped.set(entity.type, list)
    }
    const lines = ENTITY_TYPE_ORDER
      .filter(type => grouped.has(type))
      .map(type => `- ${ENTITY_TYPE_LABELS[type]}：${grouped.get(type)!.join('、')}`)
    system = `${system}\n\n以下是已知的用户信息：\n${lines.join('\n')}`
  }

  // 历史摘要注入（TDD §3.8 双轨记忆方案）：与情绪状态/RAG 召回同样的机制，追加到 system
  // 字符串而不放进 messages[]（Anthropic 分支会过滤掉 messages[] 里的 system 角色）。
  // 当前先注入全部摘要，不限制条数、不做 token 预算裁剪——session 长期运行、摘要数量增长后
  // 可能需要限制条数/接入 token 预算分配，Phase 2 现阶段先不做。
  const summaries = getSummaries(session.sessionId)
  if (summaries.length > 0) {
    const summaryText = summaries.map(s => s.content).join('\n')
    system = `${system}\n\n以下是之前对话的历史摘要：\n${summaryText}`
  }

  if (shouldTriggerRetrieval(userInput)) {
    const memories = await retrieveMemories(session.sessionId, userInput, { embedding: deps.embedding }, 5, deps.signal)
    if (memories.length > 0) {
      const snippets = memories.map(m => `- ${m.content}`).join('\n')
      system = `${system}\n\n以下是相关的历史对话片段：\n${snippets}`
    }
  }

  return { system, messages }
}