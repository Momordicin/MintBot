import type { BuiltContext, ChatMessage } from '../../../shared/types/index.js'
import { requireCurrentState, getHistory } from '../session/index.js'
import { shouldTriggerRetrieval, retrieveMemories } from '../memory/retrieval.js'
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

export async function buildContext(
  userInput: string,
  deps: { embedding: EmbeddingProvider }
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

  if (shouldTriggerRetrieval(userInput)) {
    const memories = await retrieveMemories(session.sessionId, userInput, { embedding: deps.embedding })
    if (memories.length > 0) {
      const snippets = memories.map(m => `- ${m.content}`).join('\n')
      system = `${system}\n\n以下是相关的历史对话片段：\n${snippets}`
    }
  }

  return { system, messages }
}