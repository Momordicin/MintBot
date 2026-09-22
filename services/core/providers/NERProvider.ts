import type { NerEntity } from '../../../shared/types/index.js'
import { recordActivity } from './aiActivity.js'

export interface NERProvider {
  extract(text: string): Promise<NerEntity[]>
  extractBatch(texts: string[]): Promise<NerEntity[][]>
  unload(): Promise<boolean>
}

export class Bert4NerProvider implements NERProvider {
  private baseUrl: string

  constructor(baseUrl = 'http://localhost:8765') {
    this.baseUrl = baseUrl
  }

  async extract(text: string): Promise<NerEntity[]> {
    recordActivity()
    const [result] = await this.extractBatch([text])
    return result
  }

  async extractBatch(texts: string[]): Promise<NerEntity[][]> {
    recordActivity()
    const response = await fetch(`${this.baseUrl}/ner`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(15000),
    })

    if (!response.ok) {
      throw new Error(`[NER] HTTP ${response.status}`)
    }

    const { results } = await response.json() as { results: NerEntity[][] }
    return results
  }

  async unload(): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/ner/unload`, { method: 'POST', signal: AbortSignal.timeout(5000) })

    if (!response.ok) {
      throw new Error(`[NER] HTTP ${response.status}`)
    }

    const { unloaded } = await response.json() as { unloaded: boolean }
    return unloaded
  }
}
