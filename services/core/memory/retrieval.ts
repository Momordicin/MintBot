import {
  searchSimilarMessages,
  searchMessagesFts,
  getCurrentEntities,
  getMessagesByIds,
  getMessageCreatedAtByIds,
} from '../session/queries.js'
import type { EmbeddingProvider } from '../providers/EmbeddingProvider.js'
import type { Message } from '../../../shared/types/index.js'

const RRF_K = 60

const RECENCY_BOOST_WINDOW_DAYS = 14
const RECENCY_BOOST_MAX = 0.5

function computeRecencyBoost(createdAt: number): number {
  const ageDays = (Date.now() - createdAt) / (1000 * 60 * 60 * 24)
  if (ageDays >= RECENCY_BOOST_WINDOW_DAYS || ageDays < 0) return 0
  return RECENCY_BOOST_MAX * (1 - ageDays / RECENCY_BOOST_WINDOW_DAYS)
}

const RETRIEVAL_LENGTH_THRESHOLD = 50
const QUESTION_MARKERS = ['？', '?', '吗', '呢', '为什么', '怎么', '什么', '哪', '谁', '是否']
const RECALL_KEYWORDS = ['记得', '之前', '上次', '你说过']

export function shouldTriggerRetrieval(userInput: string): boolean {
  if (userInput.length > RETRIEVAL_LENGTH_THRESHOLD) return true
  if (QUESTION_MARKERS.some(marker => userInput.includes(marker))) return true
  if (RECALL_KEYWORDS.some(keyword => userInput.includes(keyword))) return true
  return false
}

function addRrfScores(scores: Map<number, number>, orderedMessageIds: number[]): void {
  orderedMessageIds.forEach((messageId, index) => {
    const rank = index + 1
    scores.set(messageId, (scores.get(messageId) ?? 0) + 1 / (RRF_K + rank))
  })
}

export async function retrieveMemories(
  sessionId: string,
  queryText: string,
  deps: { embedding: EmbeddingProvider },
  k = 5,
  signal?: AbortSignal
): Promise<Message[]> {
  const scores = new Map<number, number>()

  try {
    const queryVector = await deps.embedding.embed(queryText, signal)
    const vecResults = searchSimilarMessages(queryVector, k * 2, sessionId)
    addRrfScores(scores, vecResults.map(r => r.messageId))
  } catch (err) {
    console.error('[Retrieval] vector search failed, skipping:', err)
  }

  try {
    const ftsResults = searchMessagesFts(queryText, sessionId, k * 2)
    addRrfScores(scores, ftsResults.map(r => r.messageId))
  } catch (err) {
    console.error('[Retrieval] FTS search failed, skipping:', err)
  }

  try {
    const entities = getCurrentEntities(sessionId)
    const matched = entities.filter(e => queryText.includes(e.value) || e.value.includes(queryText))
    addRrfScores(scores, matched.map(e => e.messageId))
  } catch (err) {
    console.error('[Retrieval] entity match failed, skipping:', err)
  }

  let createdAtById = new Map<number, number>()
  try {
    createdAtById = getMessageCreatedAtByIds([...scores.keys()])
  } catch (err) {
    console.error('[Retrieval] fetching createdAt for recency boost failed, skipping boost:', err)
  }

  const rankedIds = [...scores.entries()]
    .map(([messageId, score]): [number, number] => {
      const createdAt = createdAtById.get(messageId)
      const boostedScore = createdAt === undefined ? score : score * (1 + computeRecencyBoost(createdAt))
      return [messageId, boostedScore]
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([messageId]) => messageId)

  if (rankedIds.length === 0) return []

  try {
    const messagesById = new Map(getMessagesByIds(rankedIds).map(m => [m.id, m]))
    return rankedIds
      .map(id => messagesById.get(id))
      .filter((m): m is Message => m !== undefined)
  } catch (err) {
    console.error('[Retrieval] fetching messages by id failed, returning empty:', err)
    return []
  }
}
