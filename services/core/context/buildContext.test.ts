import { describe, it, expect, beforeEach } from 'vitest'
import { initDb } from '../db/index.js'
import { db } from '../db/index.js'
import { upsertPreset } from '../session/queries.js'
import { loadSession } from '../session/index.js'
import { buildContext } from './buildContext.js'

initDb()

beforeEach(() => {
  db.exec(`DELETE FROM Messages; DELETE FROM Sessions; DELETE FROM Presets; DELETE FROM Summaries;`)
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

describe('buildContext', () => {
  it('system 等于 preset.systemPrompt', async () => {
    const ctx = await buildContext('你好')
    expect(ctx.system).toBe('你是一个AI助手')
  })

  it('messages 最后一条是用户输入', async () => {
    const ctx = await buildContext('你好')
    const last = ctx.messages[ctx.messages.length - 1]
    expect(last.role).toBe('user')
    expect(last.content).toBe('你好')
  })

  it('没有历史消息时 messages 只有用户输入一条', async () => {
    const ctx = await buildContext('你好')
    expect(ctx.messages).toHaveLength(1)
  })

  it('有历史消息时正确拼入', async () => {
    const { addMessage } = await import('../session/index.js')
    addMessage('user', '历史消息', 'user')
    const ctx = await buildContext('新消息')
    expect(ctx.messages).toHaveLength(2)
    expect(ctx.messages[0].content).toBe('历史消息')
    expect(ctx.messages[1].content).toBe('新消息')
  })
})