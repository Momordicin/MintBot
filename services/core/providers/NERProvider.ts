// services/core/providers/NERProvider.ts — NERProvider 接口及其 HTTP 实现 Bert4NerProvider：经 AI 服务的 /ner、/ner/unload 做命名实体识别与卸载模型
// 用法：index.ts 的 start() 构造 new Bert4NerProvider(getAiBaseUrl()) 挂到 fastify.nerProvider；orchestrator 传给 entityExtractor.extractEntities 调 extractBatch，空闲时调 unload；每次 extract/extractBatch 调 recordActivity()
// 形状：extractBatch(texts) -> NerEntity[][]；unload() -> boolean
// 对应文件：services/ai/main.py / services/core/providers/aiActivity.ts / services/core/memory/entityExtractor.ts / services/core/config/ports.ts / services/core/providers/NERProvider.test.ts
import type { NerEntity } from '../../../shared/types/index.js'
import { recordActivity } from './aiActivity.js'
import { AI_URL } from '../config/ports.js'

export interface NERProvider {
  extract(text: string): Promise<NerEntity[]>
  extractBatch(texts: string[]): Promise<NerEntity[][]>
  unload(): Promise<boolean>
}

export class Bert4NerProvider implements NERProvider {
  private baseUrl: string

  constructor(baseUrl = AI_URL) {
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
