// services/core/memory/embedQueue.ts — 处理一批待嵌入消息：调 embedding provider 取向量，写入向量表与全文索引，并标记已嵌入
// 用法：orchestrator.ts 的 runOrganizeModeTick 调 processEmbedQueue(provider, batchSize, batch)
// 形状：(provider, batchSize, messages?) -> { processed, remaining }
// 对应文件：services/core/memory/orchestrator.ts / services/core/providers/EmbeddingProvider.ts / services/core/session/queries.ts / services/core/memory/embedQueue.test.ts
import {
  getPendingEmbeddingMessages,
  getPendingEmbeddingCount,
  upsertMessageEmbedding,
  indexMessageFts,
  markMessageEmbedded,
} from '../session/queries.js'
import type { EmbeddingProvider } from '../providers/EmbeddingProvider.js'
import type { Message } from '../../../shared/types/index.js'

export async function processEmbedQueue(
  provider: EmbeddingProvider,
  batchSize = 200,
  messages?: Message[]
): Promise<{ processed: number; remaining: number }> {
  const pending = messages ?? getPendingEmbeddingMessages(batchSize)
  if (pending.length === 0) {
    return { processed: 0, remaining: getPendingEmbeddingCount() }
  }

  let embeddings: number[][]
  try {
    embeddings = await provider.embedBatch(pending.map(m => m.content), undefined, 30000)
  } catch (err) {
    console.error('[EmbedQueue] batch failed, will retry:', err)
    return { processed: 0, remaining: getPendingEmbeddingCount() }
  }

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
