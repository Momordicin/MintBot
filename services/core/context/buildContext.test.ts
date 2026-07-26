import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDb } from '../db/index.js'
import { db } from '../db/index.js'
import { upsertPreset, appendMessage, insertEntity, closeEntity, upsertEmotionState, insertSummary } from '../session/queries.js'
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
    DELETE FROM EmotionStates;
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
    const sessionId = getCurrentState()!.session.sessionId
    addMessage(sessionId, 'user', '历史消息', 'user')
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

  it('有情绪状态时 system 包含情绪标签与强度', async () => {
    const sessionId = getCurrentState()!.session.sessionId
    upsertEmotionState(sessionId, { self: { label: 'curious', intensity: 0.7 }, perceived_user: null })

    const ctx = await buildContext('好的', { embedding: fakeEmbeddingProvider() })

    expect(ctx.system).toContain('curious')
    expect(ctx.system).toContain('0.7')
  })

  it('没有情绪状态时（新 session）system 就是 preset.systemPrompt，不多不少', async () => {
    const ctx = await buildContext('好的', { embedding: fakeEmbeddingProvider() })
    expect(ctx.system).toBe('你是一个AI助手')
  })

  it('同时触发情绪注入和 RAG 召回时，两段内容都出现在 system 中且互不干扰', async () => {
    const sessionId = getCurrentState()!.session.sessionId
    upsertEmotionState(sessionId, { self: { label: 'happy', intensity: 0.5 }, perceived_user: null })

    const msgId = appendMessage({
      sessionId, role: 'user', content: '我们聊过日本旅行的事', createdAt: Date.now() - 60 * 60 * 1000,
      embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
    })
    insertEntity({ messageId: msgId, sessionId, type: 'place', value: '日本', validFrom: Date.now() })

    const ctx = await buildContext('你还记得日本的事吗', { embedding: fakeEmbeddingProvider() })

    expect(ctx.system).toContain('happy')
    expect(ctx.system).toContain('0.5')
    expect(ctx.system).toContain('以下是相关的历史对话片段')
    expect(ctx.system).toContain('我们聊过日本旅行的事')
    expect(ctx.system.indexOf('happy')).toBeLessThan(ctx.system.indexOf('以下是相关的历史对话片段'))
  })

  it('有摘要时 system 包含摘要内容', async () => {
    const sessionId = getCurrentState()!.session.sessionId
    insertSummary({ sessionId, content: '用户之前提到喜欢猫，在阿里巴巴工作', fromMessageId: 1, toMessageId: 2 })

    const ctx = await buildContext('好的', { embedding: fakeEmbeddingProvider() })

    expect(ctx.system).toContain('用户之前提到喜欢猫，在阿里巴巴工作')
  })

  it('没有摘要时 system 不受影响', async () => {
    const ctx = await buildContext('好的', { embedding: fakeEmbeddingProvider() })
    expect(ctx.system).toBe('你是一个AI助手')
  })

  it('摘要 + 情绪 + RAG 三者同时存在时都正确出现在 system 中', async () => {
    const sessionId = getCurrentState()!.session.sessionId
    insertSummary({ sessionId, content: '历史摘要正文', fromMessageId: 1, toMessageId: 2 })
    upsertEmotionState(sessionId, { self: { label: 'happy', intensity: 0.5 }, perceived_user: null })

    const msgId = appendMessage({
      sessionId, role: 'user', content: '我们聊过日本旅行的事', createdAt: Date.now() - 60 * 60 * 1000,
      embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
    })
    insertEntity({ messageId: msgId, sessionId, type: 'place', value: '日本', validFrom: Date.now() })

    const ctx = await buildContext('你还记得日本的事吗', { embedding: fakeEmbeddingProvider() })

    expect(ctx.system).toContain('历史摘要正文')
    expect(ctx.system).toContain('happy')
    expect(ctx.system).toContain('以下是相关的历史对话片段')
    expect(ctx.system).toContain('我们聊过日本旅行的事')
  })

  it('有当前有效实体时 system 包含实体信息，按类型分组格式化', async () => {
    const sessionId = getCurrentState()!.session.sessionId
    insertEntity({ messageId: 1, sessionId, type: 'person', value: '老板:王总', validFrom: Date.now() })

    const ctx = await buildContext('好的', { embedding: fakeEmbeddingProvider() })

    expect(ctx.system).toContain('以下是已知的用户信息')
    expect(ctx.system).toContain('人物：老板:王总')
  })

  it('没有任何实体时 system 不受影响', async () => {
    const ctx = await buildContext('好的', { embedding: fakeEmbeddingProvider() })
    expect(ctx.system).toBe('你是一个AI助手')
  })

  it('多种类型的实体混在一起时，分组格式化正确', async () => {
    const sessionId = getCurrentState()!.session.sessionId
    insertEntity({ messageId: 1, sessionId, type: 'person', value: '老板:王总', validFrom: Date.now() })
    insertEntity({ messageId: 1, sessionId, type: 'preference', value: '喜欢猫', validFrom: Date.now() })

    const ctx = await buildContext('好的', { embedding: fakeEmbeddingProvider() })

    expect(ctx.system).toContain('人物：老板:王总')
    expect(ctx.system).toContain('偏好：喜欢猫')
  })

  it('同一类型有多个实体时，用顿号连接为一行', async () => {
    const sessionId = getCurrentState()!.session.sessionId
    // getCurrentEntities 按 validFrom DESC 排序，validFrom 更大的排前面：
    // 这里让「张三」的 validFrom 更晚，query 结果顺序为 [张三, 李四]，
    // 断言输出精确等于该顺序拼接的 "人物：张三、李四"
    insertEntity({ messageId: 1, sessionId, type: 'person', value: '李四', validFrom: Date.now() - 1000 })
    insertEntity({ messageId: 1, sessionId, type: 'person', value: '张三', validFrom: Date.now() })

    const ctx = await buildContext('好的', { embedding: fakeEmbeddingProvider() })

    expect(ctx.system).toContain('人物：张三、李四')
  })

  it('展示顺序固定为 人物/事件/偏好/地点/其他，不随查询返回顺序变化', async () => {
    const sessionId = getCurrentState()!.session.sessionId
    // 让 preference 的 validFrom 更晚，query（validFrom DESC）会先返回 preference 再返回 person，
    // 与固定展示顺序（人物先于偏好）相反——用来锁定"展示顺序是写死的数组顺序，不是跟着 Map/查询迭代顺序走"
    insertEntity({ messageId: 1, sessionId, type: 'person', value: '老板:王总', validFrom: Date.now() - 1000 })
    insertEntity({ messageId: 1, sessionId, type: 'preference', value: '喜欢猫', validFrom: Date.now() })

    const ctx = await buildContext('好的', { embedding: fakeEmbeddingProvider() })

    expect(ctx.system.indexOf('人物')).toBeLessThan(ctx.system.indexOf('偏好'))
  })

  it('实体 + 情绪 + 摘要 + RAG 四者同时存在时都正确出现在 system 中', async () => {
    const sessionId = getCurrentState()!.session.sessionId
    insertEntity({ messageId: 1, sessionId, type: 'preference', value: '喜欢猫', validFrom: Date.now() })
    insertSummary({ sessionId, content: '历史摘要正文', fromMessageId: 1, toMessageId: 2 })
    upsertEmotionState(sessionId, { self: { label: 'happy', intensity: 0.5 }, perceived_user: null })

    const msgId = appendMessage({
      sessionId, role: 'user', content: '我们聊过日本旅行的事', createdAt: Date.now() - 60 * 60 * 1000,
      embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
    })
    insertEntity({ messageId: msgId, sessionId, type: 'place', value: '日本', validFrom: Date.now() })

    const ctx = await buildContext('你还记得日本的事吗', { embedding: fakeEmbeddingProvider() })

    expect(ctx.system).toContain('偏好：喜欢猫')
    expect(ctx.system).toContain('历史摘要正文')
    expect(ctx.system).toContain('happy')
    expect(ctx.system).toContain('以下是相关的历史对话片段')
    expect(ctx.system).toContain('我们聊过日本旅行的事')
  })

  it('触发召回时，deps.signal 会原样转发到 embedding.embed，用于客户端断连时向下取消', async () => {
    const sessionId = getCurrentState()!.session.sessionId
    const msgId = appendMessage({
      sessionId, role: 'user', content: '我们聊过日本旅行的事', createdAt: Date.now() - 60 * 60 * 1000,
      embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
    })
    insertEntity({ messageId: msgId, sessionId, type: 'place', value: '日本', validFrom: Date.now() })

    let receivedSignal: AbortSignal | undefined
    const capturingEmbeddingProvider: EmbeddingProvider = {
      embed: async (_text: string, signal?: AbortSignal) => {
        receivedSignal = signal
        return new Array(1024).fill(0)
      },
      embedBatch: async (texts: string[]) => texts.map(() => new Array(1024).fill(0)),
    }
    const controller = new AbortController()

    await buildContext('你还记得日本的事吗', { embedding: capturingEmbeddingProvider, signal: controller.signal })

    expect(receivedSignal).toBe(controller.signal)
  })

  it('已关闭（validUntil 已设置）的历史实体不会被注入', async () => {
    const sessionId = getCurrentState()!.session.sessionId
    const entityId = insertEntity({ messageId: 1, sessionId, type: 'event', value: '过去的事', validFrom: Date.now() - 1000 })
    closeEntity(entityId)

    const ctx = await buildContext('好的', { embedding: fakeEmbeddingProvider() })

    expect(ctx.system).not.toContain('过去的事')
    expect(ctx.system).not.toContain('以下是已知的用户信息')
  })
})