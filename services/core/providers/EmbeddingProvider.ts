export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>
  embedBatch(texts: string[]): Promise<number[][]>
}

export class BGEProvider implements EmbeddingProvider {
  private baseUrl: string

  constructor(baseUrl = 'http://localhost:8765') {
    this.baseUrl = baseUrl
  }

  async embed(text: string): Promise<number[]> {
    const [result] = await this.embedBatch([text])
    return result
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(5000),
    })

    if (!response.ok) {
      throw new Error(`[Embedding] HTTP ${response.status}`)
    }

    const { embeddings } = await response.json() as { embeddings: number[][] }
    return embeddings
  }
}