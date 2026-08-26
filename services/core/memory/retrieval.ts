import {
  searchSimilarMessages,
  searchMessagesFts,
  getCurrentEntities,
  getMessagesByIds,
  getMessageCreatedAtByIds,
} from '../session/queries.js'
import type { EmbeddingProvider } from '../providers/EmbeddingProvider.js'
import type { Message } from '../../../shared/types/index.js'

// 三路混合召回 + RRF 融合（TDD §3.8 双轨记忆方案 / 召回时序）。
// 历史轨道走这里；近期轨道（最近 N 条 / M 分钟内）由 buildContext.ts 直接注入，不经过本模块。
//
// 三路各自独立失败：向量路依赖 EmbeddingProvider（HTTP）+ sqlite-vec 查询，FTS 路依赖
// message_fts（encryptSensitiveFields=true 时天然返回空），实体路依赖 MessageEntities 查询 +
// 子串匹配。任一路抛出异常都单独 try/catch 跳过，不影响其余路已收集的结果——与
// entityExtractor.ts 的分层容错风格一致。

// RRF（Reciprocal Rank Fusion）标准平滑常数，避免排名靠前的结果分数过度陡峭
const RRF_K = 60

// 新鲜度加成（缩小与 Zep/Graphiti 等主流记忆系统在"时间感知"上的差距）：只对最近
// RECENCY_BOOST_WINDOW_DAYS 天内的内容给一个随时间线性衰减到 0 的加成，超出窗口后加成为 0，
// 绝不倒扣分——旧记忆依然按原有 RRF 相关性正常召回，只是不再享有"新鲜"这层额外优势。
// 刻意不用指数/双曲衰减惩罚旧内容：那样会把几个月/几年前的正常记忆分数压到接近 0，
// 与"角色应该记得很久以前的事"的产品定位冲突。这两个常数是本次实现沿用的默认假设，
// 不是 TDD 强制规定的值。
const RECENCY_BOOST_WINDOW_DAYS = 14
const RECENCY_BOOST_MAX = 0.5

function computeRecencyBoost(createdAt: number): number {
  const ageDays = (Date.now() - createdAt) / (1000 * 60 * 60 * 24)
  if (ageDays >= RECENCY_BOOST_WINDOW_DAYS || ageDays < 0) return 0
  return RECENCY_BOOST_MAX * (1 - ageDays / RECENCY_BOOST_WINDOW_DAYS)
}

// 触发召回的启发式规则（没有唯一正确答案，做一个说得通的最小实现）：
// - 消息长度 > 50：长输入通常携带更多上下文，值得回忆历史
// - 疑问句特征：用户在提问，很可能在问过去发生过的事
// - 回忆类关键词：直接暗示用户在引用过去的对话
const RETRIEVAL_LENGTH_THRESHOLD = 50
const QUESTION_MARKERS = ['？', '?', '吗', '呢', '为什么', '怎么', '什么', '哪', '谁', '是否']
const RECALL_KEYWORDS = ['记得', '之前', '上次', '你说过']

export function shouldTriggerRetrieval(userInput: string): boolean {
  if (userInput.length > RETRIEVAL_LENGTH_THRESHOLD) return true
  if (QUESTION_MARKERS.some(marker => userInput.includes(marker))) return true
  if (RECALL_KEYWORDS.some(keyword => userInput.includes(keyword))) return true
  return false
}

// 将某一路已排好序的 messageId 列表按 1-indexed rank 累加进融合分数表
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

  // 向量路
  try {
    const queryVector = await deps.embedding.embed(queryText, signal)
    const vecResults = searchSimilarMessages(queryVector, k * 2, sessionId)
    addRrfScores(scores, vecResults.map(r => r.messageId))
  } catch (err) {
    console.error('[Retrieval] vector search failed, skipping:', err)
  }

  // FTS 路（已按相关性排好序）
  try {
    const ftsResults = searchMessagesFts(queryText, sessionId, k * 2)
    addRrfScores(scores, ftsResults.map(r => r.messageId))
  } catch (err) {
    console.error('[Retrieval] FTS search failed, skipping:', err)
  }

  // 实体路：子串双向匹配，命中的实体已按 validFrom desc 排序，直接作为 rank 顺序
  try {
    const entities = getCurrentEntities(sessionId)
    const matched = entities.filter(e => queryText.includes(e.value) || e.value.includes(queryText))
    addRrfScores(scores, matched.map(e => e.messageId))
  } catch (err) {
    console.error('[Retrieval] entity match failed, skipping:', err)
  }

  // 新鲜度加成：查候选消息的 createdAt，对最近 RECENCY_BOOST_WINDOW_DAYS 天内的候选做有上限的
  // 加成后再排序。查询失败（数据库错误）时降级为跳过加成、维持原始 RRF 分数，不让整个召回失败——
  // 与上面三路一致的容错风格
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

  // 回查原文本身也可能失败（数据库错误 / 解密失败），召回是锦上添花，不该让整个对话回合失败——
  // 与上面三路一致，独立 try/catch，失败时退化为无召回结果
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
