// services/core/providers/EmbeddingProvider.ts — EmbeddingProvider 接口及其 HTTP 实现 BGEProvider：经 AI 服务的 /embed、/embed/unload 取向量与卸载模型；另有 AI 服务 /health 的 embedding 就绪检查
// 用法：index.ts 的 start() 构造 new BGEProvider(getAiBaseUrl()) 挂到 fastify.embeddingProvider，并在 AI 服务就绪后 embed("ping") 预热；buildContext / retrieval / embedQueue / orchestrator 通过该接口使用；routes/status.ts 与 state.ts 调 isEmbeddingReady；每次 embed/embedBatch 调 recordActivity()
// 形状：embed(text) -> number[]；embedBatch(texts) -> number[][]；unload() -> boolean
// 对应文件：services/ai/main.py / services/core/providers/aiActivity.ts / services/core/providers/aiService.ts / services/core/config/ports.ts / services/core/providers/EmbeddingProvider.test.ts
import { recordActivity } from './aiActivity.js'
import { AI_URL } from '../config/ports.js'
import { AI_SERVICE_IDENTITY } from './aiService.js'

export interface EmbeddingProvider {
  embed(text: string, signal?: AbortSignal, timeoutMs?: number): Promise<number[]>
  embedBatch(texts: string[], signal?: AbortSignal, timeoutMs?: number): Promise<number[][]>
  unload(): Promise<boolean>
}

export class BGEProvider implements EmbeddingProvider {
  private baseUrl: string

  constructor(baseUrl = AI_URL) {
    this.baseUrl = baseUrl
  }

  async embed(text: string, signal?: AbortSignal, timeoutMs = 5000): Promise<number[]> {
    recordActivity()
    const [result] = await this.embedBatch([text], signal, timeoutMs)
    return result
  }

  async embedBatch(texts: string[], signal?: AbortSignal, timeoutMs = 5000): Promise<number[][]> {
    recordActivity()
    const combinedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
    const response = await fetch(`${this.baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts }),
      signal: combinedSignal,
    })

    if (!response.ok) {
      throw new Error(`[Embedding] HTTP ${response.status}`)
    }

    const { embeddings } = await response.json() as { embeddings: number[][] }
    return embeddings
  }

  async unload(): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/embed/unload`, { method: 'POST', signal: AbortSignal.timeout(5000) })

    if (!response.ok) {
      throw new Error(`[Embedding] HTTP ${response.status}`)
    }

    const { unloaded } = await response.json() as { unloaded: boolean }
    return unloaded
  }
}

export function getAiBaseUrl(): string {
  return AI_URL
}

export async function isEmbeddingReady(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) })
    if (!response.ok) return false
    const body = await response.json() as { service?: string; embedding_loaded?: boolean }
    if (body.service !== AI_SERVICE_IDENTITY) return false
    return body.embedding_loaded === true
  } catch {
    return false
  }
}