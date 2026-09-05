import { describe, it, expect, afterEach, vi } from 'vitest'
import { initDb } from './db/index.js'
import { upsertPreset } from './session/queries.js'
import { loadSession } from './session/index.js'
import { recordAttention, markExplicitSleep } from './session/attention.js'
import { buildStatePayload } from './state.js'

// 本文件的用例不涉及 modelType === 'ollama' 分支（没有已加载的 preset/session），
// buildStatePayload 内部不会读到 getModelProviderConfig()，mock 只是满足模块可导入
vi.mock('./config/index.js', () => ({
  getModelProviderConfig: vi.fn(() => ({ type: 'ollama' })),
}))

initDb()

// buildStatePayload 本身依赖较多状态（session/preset/emotion 等），这里只关心 embeddingReady
// 这一个字段是否正确复用 isEmbeddingReady（与 GET /embedding-ready 共用同一逻辑，见 EmbeddingProvider.ts）
describe('buildStatePayload — embeddingReady', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('AI 服务健康检查返回 embedding_loaded=true 时，embeddingReady 为 true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', embedding_loaded: true, ner_loaded: false }),
    }))

    const payload = await buildStatePayload()

    expect(payload.embeddingReady).toBe(true)
  })

  it('AI 服务健康检查返回 embedding_loaded=false 时，embeddingReady 为 false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', embedding_loaded: false, ner_loaded: false }),
    }))

    const payload = await buildStatePayload()

    expect(payload.embeddingReady).toBe(false)
  })

  it('AI 服务不可达时，embeddingReady 为 false，不向上抛出', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    const payload = await buildStatePayload()

    expect(payload.embeddingReady).toBe(false)
  })
})

// 悬浮窗立绘状态模型（TDD §3.7 附）供 GET /state 重建用的两个字段。session/index.ts 的
// current 是模块级单例，"没有激活 session" 这条必须排在本文件所有 loadSession() 调用之前，
// 与 internal.test.ts 同样的顺序要求
describe('buildStatePayload — lastAttentionAt / explicitSleep', () => {
  it('没有激活 session 时，lastAttentionAt 为 null，explicitSleep 为 false', async () => {
    const payload = await buildStatePayload()

    expect(payload.lastAttentionAt).toBeNull()
    expect(payload.explicitSleep).toBe(false)
  })

  it('有激活 session 时，两个字段反映 session/attention 模块的当前值', async () => {
    upsertPreset({
      presetId: 'p-state-attention', name: '角色', characterId: 'char-001',
      modelType: 'ollama', modelName: 'qwen3', systemPrompt: '你是角色',
    })
    const { session } = loadSession('p-state-attention')
    recordAttention(session.sessionId, 12345)
    markExplicitSleep(session.sessionId)

    const payload = await buildStatePayload()

    expect(payload.lastAttentionAt).toBe(12345)
    expect(payload.explicitSleep).toBe(true)
  })
})
