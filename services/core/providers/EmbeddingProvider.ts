export interface EmbeddingProvider {
  embed(text: string, signal?: AbortSignal): Promise<number[]>
  embedBatch(texts: string[], signal?: AbortSignal): Promise<number[][]>
}

export class BGEProvider implements EmbeddingProvider {
  private baseUrl: string

  constructor(baseUrl = 'http://localhost:8765') {
    this.baseUrl = baseUrl
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const [result] = await this.embedBatch([text], signal)
    return result
  }

  async embedBatch(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    // 调用方（/chat 请求）传入自己的 signal 时，与固定 5 秒超时取先触发者一起取消这次 fetch——
    // 否则客户端提前断连后，这个 embedding 调用仍会跑满 5 秒，而回复队列是全局 FIFO，
    // 会连带拖慢排在它后面、真正有人等待的请求。不传 signal 时（如整理模式的批量后台
    // embedding）保持原有行为不变，只用固定超时
    const combinedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000)
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
}