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
  return `http://localhost:${process.env.AI_PORT ?? '8765'}`
}

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