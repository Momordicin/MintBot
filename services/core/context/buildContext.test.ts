import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDb } from '../db/index.js'
import { db } from '../db/index.js'
import { upsertPreset, appendMessage, insertEntity } from '../session/queries.js'
import { loadSession, getCurrentState } from '../session/index.js'
import { buildContext } from './buildContext.js'
import type { EmbeddingProvider } from '../providers/EmbeddingProvider.js'

initDb()

// 假 EmbeddingProvider（参考 embedQueue.test.ts 的 fakeProvider 写法）：不依赖真实向量匹配，
// 本文件的召回断言走 FTS 路，向量路返回值本身不影响这些用例
function fakeEmbeddingProvider(): EmbeddingProvider {
  return {
    async embed() {
      return new Array(1024).fill(0)
    },
    async embedBatch(texts: string[]) {
      return texts.map(() => new Array(1024).fill(0))
    },
  }
}

const prevFlag = process.env.ENCRYPT_SENSITIVE_FIELDS
beforeEach(() => {
  // FTS 召回断言要求本地模式（encryptSensitiveFields=false，本地默认）
  delete process.env.ENCRYPT_SENSITIVE_FIELDS
  db.exec(`
    DELETE FROM Messages; DELETE FROM Sessions; DELETE FROM Presets; DELETE FROM Summaries;
    DELETE FROM message_fts; DELETE FROM message_embeddings; DELETE FROM MessageEntities;
  `)
  upsertPreset({
    presetId: 'p1',
    name: '测试角色',
    characterId: 'char-001',
    modelType: 'ollama',
    modelName: 'qwen3',
    systemPrompt: '你是一个AI助手',
  })
  loadSession('p1')
})
afterEach(() => {
  process.env.ENCRYPT_SENSITIVE_FIELDS = prevFlag
})

describe('buildContext', () => {
  it('system 等于 preset.systemPrompt（未触发召回时）', async () => {
    const ctx = await buildContext('你好', { embedding: fakeEmbeddingProvider() })
    expect(ctx.system).toBe('你是一个AI助手')
  })

  it('messages 最后一条是用户输入', async () => {
    const ctx = await buildContext('你好', { embedding: fakeEmbeddingProvider() })
    const last = ctx.messages[ctx.messages.length - 1]
    expect(last.role).toBe('user')
    expect(last.content).toBe('你好')
  })

  it('没有历史消息时 messages 只有用户输入一条', async () => {
    const ctx = await buildContext('你好', { embedding: fakeEmbeddingProvider() })
    expect(ctx.messages).toHaveLength(1)
  })

  it('有历史消息时正确拼入', async () => {
    const { addMessage } = await import('../session/index.js')
    addMessage('user', '历史消息', 'user')
    const ctx = await buildContext('新消息', { embedding: fakeEmbeddingProvider() })
    expect(ctx.messages).toHaveLength(2)
    expect(ctx.messages[0].content).toBe('历史消息')
    expect(ctx.messages[1].content).toBe('新消息')
  })

  it('近期轨道被 30 分钟边界截断：超过 30 分钟的历史消息不进入 messages', async () => {
    const sessionId = getCurrentState()!.session.sessionId
    const now = Date.now()
    // 40 分钟前的消息应被排除，10 分钟前的消息应保留
    appendMessage({
      sessionId, role: 'user', content: '很久之前的消息', createdAt: now - 40 * 60 * 1000,
      embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
    })
    appendMessage({
      sessionId, role: 'user', content: '最近的消息', createdAt: now - 10 * 60 * 1000,
      embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
    })

    const ctx = await buildContext('新消息', { embedding: fakeEmbeddingProvider() })

    expect(ctx.messages).toHaveLength(2)
    expect(ctx.messages[0].content).toBe('最近的消息')
    expect(ctx.messages[1].content).toBe('新消息')
  })

  it('触发召回时 system 末尾被追加相关历史片段', async () => {
    const sessionId = getCurrentState()!.session.sessionId
    const msgId = appendMessage({
      sessionId, role: 'user', content: '我们聊过日本旅行的事', createdAt: Date.now() - 60 * 60 * 1000,
      embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
    })
    // 用实体路保证确定性命中（不依赖 FTS5 对中文分词的具体行为）
    insertEntity({ messageId: msgId, sessionId, type: 'place', value: '日本', validFrom: Date.now() })

    // "记得" 命中回忆类关键词触发召回；"日本" 子串匹配上面插入的实体
    const ctx = await buildContext('你还记得日本的事吗', { embedding: fakeEmbeddingProvider() })

    expect(ctx.system).toContain('以下是相关的历史对话片段')
    expect(ctx.system).toContain('我们聊过日本旅行的事')
  })

  it('不触发召回时 system 保持原样', async () => {
    const ctx = await buildContext('好的', { embedding: fakeEmbeddingProvider() })
    expect(ctx.system).toBe('你是一个AI助手')
  })
})