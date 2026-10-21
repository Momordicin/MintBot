// services/core/providers/EmbeddingProvider.ts — EmbeddingProvider 接口及其 HTTP 实现 BGEProvider，另有 AI 服务可用性探测
// 用法：index.ts 的 start() 构造 new BGEProvider(getAiBaseUrl()) 挂到 fastify.embeddingProvider；buildContext / retrieval / embedQueue / orchestrator 通过该接口使用；routes/status.ts 与 state.ts 调 isAiServiceAvailable
// 对应文件：services/ai/main.py / services/core/providers/aiActivity.ts / services/core/providers/aiService.ts / services/core/config/ports.ts / services/core/providers/EmbeddingProvider.test.ts
import { recordActivity } from './aiActivity.js'
import { AI_URL } from '../config/ports.js'
import { AI_SERVICE_IDENTITY, isAiServiceStartableOnDemand, runAiRequest } from './aiService.js'

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
    return runAiRequest(this.baseUrl, signal, async () => {
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
    })
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

export async function isAiServiceAvailable(baseUrl: string): Promise<boolean> {
  if (isAiServiceStartableOnDemand()) return true
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) })
    if (!response.ok) return false
    const body = await response.json() as { service?: string }
    return body.service === AI_SERVICE_IDENTITY
  } catch {
    return false
  }
}