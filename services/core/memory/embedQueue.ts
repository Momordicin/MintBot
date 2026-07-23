import {
  getPendingEmbeddingMessages,
  getPendingEmbeddingCount,
  upsertMessageEmbedding,
  indexMessageFts,
  markMessageEmbedded,
} from '../session/queries.js'
import type { EmbeddingProvider } from '../providers/EmbeddingProvider.js'

// 单批次 embedding 队列处理器（TDD §3.8）。
// 只负责"处理一批 pending 记录"，不负责整理模式触发条件判断（pendingCount>100 /
// oldestPendingAge>120min / activeConversation / 时间窗口）或多批次循环调用，
// 这些由整理模式编排器（后续实现）负责：处理完一批后自行检查条件、决定是否继续下一批。
export async function processEmbedQueue(
  provider: EmbeddingProvider,
  batchSize = 200
): Promise<{ processed: number; remaining: number }> {
  const pending = getPendingEmbeddingMessages(batchSize)
  if (pending.length === 0) {
    return { processed: 0, remaining: 0 }
  }

  let embeddings: number[][]
  try {
    embeddings = await provider.embedBatch(pending.map(m => m.content))
  } catch (err) {
    // 失败补偿（TDD §3.1）：不标记 embedded，留待下次整理模式运行时重试
    console.error('[EmbedQueue] batch failed, will retry:', err)
    return { processed: 0, remaining: getPendingEmbeddingCount() }
  }

  // 逐条写入：先写向量 + FTS 索引，成功后才标记 embedded，
  // 保证中途失败时已写入的记录状态一致，未处理到的记录保持 pending 由下次运行补偿
  let processed = 0
  for (let i = 0; i < pending.length; i++) {
    const msg = pending[i]
    upsertMessageEmbedding(msg.id, msg.sessionId, embeddings[i])
    indexMessageFts(msg.id, msg.sessionId, msg.content)
    markMessageEmbedded(msg.id)
    processed++
  }

  return { processed, remaining: getPendingEmbeddingCount() }
}
