import type { BuiltContext, ChatMessage, MessageEntity } from '../../../shared/types/index.js'
import { requireCurrentState, getHistory } from '../session/index.js'
import { shouldTriggerRetrieval, retrieveMemories } from '../memory/retrieval.js'
import { getEmotionState, getSummaries, getCurrentEntities, getSupersededMessageIds } from '../session/queries.js'
import type { EmbeddingProvider } from '../providers/EmbeddingProvider.js'
import { getMemoryConfig } from '../config/index.js'

function truncateToCharBudget<T>(
  items: T[],
  budget: number,
  getText: (item: T) => string,
  dropFrom: 'oldest' | 'lowest-ranked'
): T[] {
  const result = [...items]
  const totalLength = () => result.reduce((sum, item) => sum + getText(item).length, 0)
  while (result.length > 1 && totalLength() > budget) {
    if (dropFrom === 'oldest') result.shift()
    else result.pop()
  }
  return result
}

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
  const { session, preset, manifest } = requireCurrentState()
  const memoryConfig = getMemoryConfig()

  const history = truncateToCharBudget(
    getHistory(memoryConfig.recentTrackMaxMessages)
      .filter(m => m.createdAt >= Date.now() - memoryConfig.recentTrackMaxMinutes * 60_000),
    memoryConfig.contextBudget.recentMessages,
    m => m.content,
    'oldest'
  )

  const messages: ChatMessage[] = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: userInput },
  ]

  let system = preset.systemPrompt  

  const emotion = getEmotionState(session.sessionId)
  if (emotion) {
    system = `${system}\n\n你当前的情绪状态是「${emotion.self.label}」，强度为 ${emotion.self.intensity}，请让回复的语气与这一情绪保持连贯。`
  }

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

  const summaries = truncateToCharBudget(getSummaries(session.sessionId), memoryConfig.contextBudget.summary, s => s.content, 'oldest')
  if (summaries.length > 0) {
    const summaryText = summaries.map(s => s.content).join('\n')
    system = `${system}\n\n以下是之前对话的历史摘要：\n${summaryText}`
  }

  if (shouldTriggerRetrieval(userInput)) {
    const memories = truncateToCharBudget(
      await retrieveMemories(session.sessionId, userInput, { embedding: deps.embedding }, 5, deps.signal),
      memoryConfig.contextBudget.rag,
      m => m.content,
      'lowest-ranked'
    )
    if (memories.length > 0) {
      let supersededIds = new Set<number>()
      try {
        supersededIds = getSupersededMessageIds(memories.map(m => m.id))
      } catch (err) {
        console.error('[BuildContext] fetching superseded message ids failed, skipping annotation:', err)
      }
      const snippets = memories.map(m => `- ${supersededIds.has(m.id) ? '（可能已过时）' : ''}${m.content}`).join('\n')
      system = `${system}\n\n以下是相关的历史对话片段：\n${snippets}`
    }
  }

  const contractLines: string[] = []
  if (manifest && manifest.emotionVocabulary.length > 0) {
    contractLines.push(`可用的情绪标签（emotion.self.label 只能从中选择一个）：${manifest.emotionVocabulary.join('、')}`)
  }
  if (manifest && manifest.emoteTagVocabulary.length > 0) {
    contractLines.push(`可用的表情 tag（emote 字段可选，只能从中选择一个 tag 本身，不能选文件名）：${manifest.emoteTagVocabulary.join('、')}`)
  }
  if (preset.addressForms.length > 0) {
    contractLines.push(`你可以这样称呼用户（自行挑选，不必每轮都用同一个）：${preset.addressForms.join('、')}`)
  }
  contractLines.push('请严格用以下 JSON 格式回复，不要输出任何其他内容：\n{"reply": "你的回复内容", "emotion": {"self": {"label": "情绪标签", "intensity": 0.7}, "perceived_user": null}, "emote": "表情 tag（可选，不附表情时省略该字段）"}')
  system = `${system}\n\n${contractLines.join('\n')}`

  if (!/json/i.test(system)) {
    throw new Error('[BuildContext] system prompt must contain the literal word "json" (required by OpenAI/DeepSeek json_object mode)')
  }

  return { system, messages }
}