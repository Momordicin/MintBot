import { recordActivity } from './aiActivity.js'

export interface EmbeddingProvider {
  embed(text: string, signal?: AbortSignal, timeoutMs?: number): Promise<number[]>
  embedBatch(texts: string[], signal?: AbortSignal, timeoutMs?: number): Promise<number[][]>
  unload(): Promise<boolean>
}

export class BGEProvider implements EmbeddingProvider {
  private baseUrl: string

  constructor(baseUrl = 'http://localhost:8765') {
    this.baseUrl = baseUrl
  }

  async embed(text: string, signal?: AbortSignal, timeoutMs = 5000): Promise<number[]> {
    recordActivity()
    const [result] = await this.embedBatch([text], signal, timeoutMs)
    return result
  }

  async embedBatch(texts: string[], signal?: AbortSignal, timeoutMs = 5000): Promise<number[][]> {
    recordActivity()
    // 调用方（/chat 请求）传入自己的 signal 时，与固定超时（默认 5 秒，调用方可通过 timeoutMs
    // 覆盖——例如启动预热调用需要更长的冷加载耐心）取先触发者一起取消这次 fetch——
    // 否则客户端提前断连后，这个 embedding 调用仍会跑满超时时长，而回复队列是全局 FIFO，
    // 会连带拖慢排在它后面、真正有人等待的请求。不传 signal 时（如整理模式的批量后台
    // embedding）保持原有行为不变，只用固定超时
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

// 供 index.ts（构造 provider）、state.ts（GET /state）、routes/status.ts（GET /embedding-ready）
// 共用，避免 AI 服务 baseUrl 的拼接逻辑在三处各自重复一份
export function getAiBaseUrl(): string {
  return `http://localhost:${process.env.AI_PORT ?? '8765'}`
}

// 供 GET /embedding-ready（轻量轮询端点）和 buildStatePayload（GET /state）共用，
// 避免两处各自实现一遍健康检查逻辑；风格与 providers/ollama.ts 的 isOllamaRunning 一致
export async function isEmbeddingReady(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) })
    if (!response.ok) return false
    const { embedding_loaded } = await response.json() as { embedding_loaded: boolean }
    return embedding_loaded
  } catch {
    return false
  }
}