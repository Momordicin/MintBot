import { describe, it, expect, beforeEach } from 'vitest'
import { db, initDb } from '../db/index.js'
import { appendMessage, insertEntity, getCurrentEntities } from '../session/queries.js'
import { extractEntities, type EntityModelProvider } from './entityExtractor.js'
import type { NERProvider } from '../providers/NERProvider.js'
import type { Message, NerEntity } from '../../../shared/types/index.js'

initDb()
beforeEach(() => {
  db.exec(`DELETE FROM Messages; DELETE FROM MessageEntities;`)
})

function addMessage(sessionId: string, content: string, createdAt = Date.now()): Message {
  const id = appendMessage({
    sessionId, role: 'user', content, createdAt,
    embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
  })
  return { id, sessionId, role: 'user', content, createdAt, embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null }
}

// 空 NER / 空主模型响应假实现：用于只想验证规则层的用例
function emptyNer(): NERProvider {
  return {
    async extract() { return [] },
    async extractBatch(texts: string[]) { return texts.map(() => []) },
    async unload() { return true },
  }
}

function emptyModel(): EntityModelProvider {
  return { async completeSync() { return '{"techTerms":[],"changes":[]}' } }
}

function nerReturning(results: NerEntity[][]): NERProvider {
  return {
    async extract() { return results[0] ?? [] },
    async extractBatch() { return results },
    async unload() { return true },
  }
}

function modelReturning(json: string): EntityModelProvider {
  return { async completeSync() { return json } }
}

function throwingNer(): NERProvider {
  return {
    async extract() { throw new Error('ner boom') },
    async extractBatch() { throw new Error('ner boom') },
    async unload() { return true },
  }
}

function throwingModel(): EntityModelProvider {
  return { async completeSync() { throw new Error('model boom') } }
}

describe('extractEntities — Layer 1 规则', () => {
  it('偏好 / 关系 / 工作 三类规则各自命中并落库为正确的 type + value', async () => {
    const preferenceMsg = addMessage('s1', '我喜欢猫')
    const relationMsg = addMessage('s1', '我的老板是王总')
    const workMsg = addMessage('s1', '我在阿里巴巴工作')

    const result = await extractEntities([preferenceMsg, relationMsg, workMsg], { ner: emptyNer(), model: emptyModel() })
    expect(result).toEqual({ inserted: 3, closed: 0 })

    const entities = getCurrentEntities('s1')
    expect(entities).toHaveLength(3)
    expect(entities.find(e => e.type === 'preference')?.value).toBe('喜欢猫')
    expect(entities.find(e => e.type === 'person')?.value).toBe('老板:王总')
    expect(entities.find(e => e.type === 'other')?.value).toBe('工作单位:阿里巴巴')
  })

  it('无消息或全部为 assistant 消息时不调用任何 provider，直接返回零计数', async () => {
    const assistantMsg: Message = {
      id: 1, sessionId: 's1', role: 'assistant', content: '我喜欢猫', createdAt: Date.now(),
      embedded: false, summarized: false, visibleToUser: true, trigger: 'user', triggerEventId: null,
    }
    const result = await extractEntities([assistantMsg], { ner: throwingNer(), model: throwingModel() })
    expect(result).toEqual({ inserted: 0, closed: 0 })
  })
})

describe('extractEntities — Layer 2 NER 标签映射', () => {
  it('PER→person, LOC→place, ORG→other, TIME→event', async () => {
    const msg = addMessage('s1', '张三下周在北京拜访阿里巴巴')
    const ner = nerReturning([[
      { text: '张三', label: 'PER', start: 0, end: 2 },
      { text: '北京', label: 'LOC', start: 5, end: 7 },
      { text: '阿里巴巴', label: 'ORG', start: 9, end: 13 },
      { text: '下周', label: 'TIME', start: 2, end: 4 },
    ]])

    const result = await extractEntities([msg], { ner, model: emptyModel() })
    expect(result.inserted).toBe(4)

    const entities = getCurrentEntities('s1')
    expect(entities.find(e => e.value === '张三')?.type).toBe('person')
    expect(entities.find(e => e.value === '北京')?.type).toBe('place')
    expect(entities.find(e => e.value === '阿里巴巴')?.type).toBe('other')
    expect(entities.find(e => e.value === '下周')?.type).toBe('event')
  })

  it('未知 label 被跳过，不落库也不报错', async () => {
    const msg = addMessage('s1', '一些文本')
    const ner = nerReturning([[{ text: 'x', label: 'MISC', start: 0, end: 1 }]])
    const result = await extractEntities([msg], { ner, model: emptyModel() })
    expect(result).toEqual({ inserted: 0, closed: 0 })
  })
})

describe('extractEntities — 去重', () => {
  it('同 session + 同 type + 同 value 的当前有效实体已存在时跳过插入', async () => {
    const msg = addMessage('s1', '我喜欢猫')
    insertEntity({ messageId: 999, sessionId: 's1', type: 'preference', value: '喜欢猫', validFrom: 1000 })

    const result = await extractEntities([msg], { ner: emptyNer(), model: emptyModel() })
    expect(result).toEqual({ inserted: 0, closed: 0 })
    expect(getCurrentEntities('s1', 'preference')).toHaveLength(1)
  })
})

describe('extractEntities — 双时态实体变更（Layer 3）', () => {
  it('Layer 3 标记变更后：旧实体被 closeEntity（validUntil 被设置），新实体作为当前有效实体插入', async () => {
    const oldId = insertEntity({ messageId: 1, sessionId: 's1', type: 'other', value: '工作单位:旧公司', validFrom: 1000 })
    const msg = addMessage('s1', '我现在在新公司工作了', 5000)

    const changeJson = JSON.stringify({
      techTerms: [],
      changes: [{ messageId: msg.id, type: 'other', oldValue: '工作单位:旧公司', newValue: '工作单位:新公司' }],
    })

    // 规则层本身也会命中"我在新公司工作"产生同一条新值，验证变更逻辑与规则层去重协同不重复插入
    const result = await extractEntities([msg], { ner: emptyNer(), model: modelReturning(changeJson) })

    expect(result.closed).toBe(1)
    expect(result.inserted).toBe(1)

    const current = getCurrentEntities('s1')
    expect(current).toHaveLength(1)
    expect(current[0].value).toBe('工作单位:新公司')

    const oldRow = db.prepare(`SELECT * FROM MessageEntities WHERE id = ?`).get(oldId) as any
    expect(oldRow.validUntil).not.toBeNull()
  })

  it('变更的 oldValue 在当前实体中找不到匹配时，不关闭任何记录，但仍插入新值', async () => {
    const msg = addMessage('s1', '普通消息', 5000)
    const changeJson = JSON.stringify({
      techTerms: [],
      changes: [{ messageId: msg.id, type: 'other', oldValue: '工作单位:不存在', newValue: '工作单位:新公司' }],
    })

    const result = await extractEntities([msg], { ner: emptyNer(), model: modelReturning(changeJson) })
    expect(result.closed).toBe(0)
    expect(result.inserted).toBe(1)
    expect(getCurrentEntities('s1')[0].value).toBe('工作单位:新公司')
  })
})

describe('extractEntities — 分层容错（每层独立失败）', () => {
  it('NER 层抛出异常时，规则层结果仍正常落库', async () => {
    const msg = addMessage('s1', '我喜欢猫')
    const result = await extractEntities([msg], { ner: throwingNer(), model: emptyModel() })
    expect(result).toEqual({ inserted: 1, closed: 0 })
    expect(getCurrentEntities('s1', 'preference')).toHaveLength(1)
  })

  it('主模型抛出异常时，规则层 + NER 层结果仍正常落库', async () => {
    const msg = addMessage('s1', '我喜欢猫')
    const ner = nerReturning([[{ text: '张三', label: 'PER', start: 0, end: 2 }]])
    const result = await extractEntities([msg], { ner, model: throwingModel() })
    expect(result).toEqual({ inserted: 2, closed: 0 })
  })

  it('主模型返回畸形 JSON 时，Layer 3 被跳过，其余层结果仍正常落库', async () => {
    const msg = addMessage('s1', '我喜欢猫')
    const result = await extractEntities([msg], { ner: emptyNer(), model: modelReturning('这不是 JSON') })
    expect(result).toEqual({ inserted: 1, closed: 0 })
  })

  it('主模型返回结构不合法（techTerms/changes 缺失或类型错误）时，Layer 3 被安全忽略', async () => {
    const msg = addMessage('s1', '我喜欢猫')
    const result = await extractEntities([msg], { ner: emptyNer(), model: modelReturning('{"techTerms": "not-an-array"}') })
    expect(result).toEqual({ inserted: 1, closed: 0 })
  })
})
