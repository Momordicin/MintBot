import { describe, it, expect, beforeEach } from 'vitest'
import { db, initDb } from '../db/index.js'
import { appendMessage, insertEntity, getCurrentEntities } from '../session/queries.js'
import { extractEntities, type EntityModelProvider } from './entityExtractor.js'
import type { NERProvider } from '../providers/NERProvider.js'
import type { Message, NerEntity } from '../../../shared/types/index.js'

// entityExtractor.ts 不再引用 config 模块（maxTokens 现在随 deps.model 一起从 index.ts 组装
// 时带入，见 ModelProvider.resolveMaxTokens），本文件因此不需要 mock config/index.js——此前
// 这里的 mock 只是为了绕开 getBackgroundModelProviderConfig() 在未配置时抛错（config.json 是
// gitignored 的，CI 上没有这个文件），现在这个理由已经不存在

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
  return { async completeSync() { return '{"changes":[]}' } }
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
      changes: [{ messageId: msg.id, type: 'other', oldValue: '工作单位:不存在', newValue: '工作单位:新公司' }],
    })

    const result = await extractEntities([msg], { ner: emptyNer(), model: modelReturning(changeJson) })
    expect(result.closed).toBe(0)
    expect(result.inserted).toBe(1)
    expect(getCurrentEntities('s1')[0].value).toBe('工作单位:新公司')
  })

  it('主模型回复被 ```json 代码块包裹时，仍能正确解析出变更（parseLayer3Response 通过共用的 parseJsonSalvage 兜底）', async () => {
    const oldId = insertEntity({ messageId: 1, sessionId: 's1', type: 'other', value: '工作单位:旧公司', validFrom: 1000 })
    const msg = addMessage('s1', '我现在在新公司工作了', 5000)

    const fenced = '```json\n' + JSON.stringify({
      changes: [{ messageId: msg.id, type: 'other', oldValue: '工作单位:旧公司', newValue: '工作单位:新公司' }],
    }) + '\n```'

    const result = await extractEntities([msg], { ner: emptyNer(), model: modelReturning(fenced) })

    expect(result.closed).toBe(1)
    expect(result.inserted).toBe(1)
    const oldRow = db.prepare(`SELECT * FROM MessageEntities WHERE id = ?`).get(oldId) as any
    expect(oldRow.validUntil).not.toBeNull()
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

  it('主模型返回结构不合法（changes 缺失或类型错误）时，Layer 3 被安全忽略', async () => {
    const msg = addMessage('s1', '我喜欢猫')
    const result = await extractEntities([msg], { ner: emptyNer(), model: modelReturning('{"changes": "not-an-array"}') })
    expect(result).toEqual({ inserted: 1, closed: 0 })
  })
})

describe('extractEntities — Layer 3 不再抽取技术词', () => {
  it('消息中出现技术词时，不会被抽取为 type:other 实体（改为交给 message_fts 全文检索）', async () => {
    const msg = addMessage('s1', '我在学习 React 和 TypeScript')
    const result = await extractEntities([msg], { ner: emptyNer(), model: emptyModel() })
    expect(result).toEqual({ inserted: 0, closed: 0 })

    const entities = getCurrentEntities('s1')
    expect(entities.find(e => e.value === 'React')).toBeUndefined()
    expect(entities.find(e => e.value === 'TypeScript')).toBeUndefined()
  })

  it('主模型返回 techTerms 字段（假设仍有旧版 provider 残留）时被直接忽略，不落库也不报错', async () => {
    const msg = addMessage('s1', '普通消息')
    const json = JSON.stringify({ techTerms: [{ messageId: msg.id, value: 'React' }], changes: [] })
    const result = await extractEntities([msg], { ner: emptyNer(), model: modelReturning(json) })
    expect(result).toEqual({ inserted: 0, closed: 0 })
    expect(getCurrentEntities('s1')).toHaveLength(0)
  })
})

describe('extractEntities — Layer 3 候选实体收窄（selectLayer3Candidates）', () => {
  it('旧实体的 value 不出现在描述新事实的消息原文里时，仍然要被带入 Layer 3 prompt', async () => {
    // 典型的实体变更场景：用户叙述新事实本身，不会重复旧值——"我现在在新公司工作了"这句话里
    // 根本不会出现"旧公司"。候选列表不能依赖"消息原文是否提到旧值"来筛选，否则这个 Layer 3
    // 存在的核心目的（检测变更）反而会被过滤掉，这是之前一版实现的真实回归，这里专门锁住
    insertEntity({ messageId: 1, sessionId: 's1', type: 'other', value: '工作单位:旧公司', validFrom: 1000 })
    const msg = addMessage('s1', '我现在在新公司工作了', 5000)

    let capturedSystem = ''
    const capturingModel: EntityModelProvider = {
      async completeSync(context) {
        capturedSystem = context.system
        return '{"changes":[]}'
      },
    }

    await extractEntities([msg], { ner: emptyNer(), model: capturingModel })

    expect(capturedSystem).toContain('工作单位:旧公司')
  })

  it('同一 type 的候选数量超过上限（20）时，只保留最近的 20 条', async () => {
    const msg = addMessage('s1', '随便聊聊', 100000)
    for (let i = 0; i < 25; i++) {
      insertEntity({ messageId: i + 1, sessionId: 's1', type: 'other', value: `实体${i}`, validFrom: 1000 + i })
    }

    let capturedSystem = ''
    const capturingModel: EntityModelProvider = {
      async completeSync(context) {
        capturedSystem = context.system
        return '{"changes":[]}'
      },
    }

    await extractEntities([msg], { ner: emptyNer(), model: capturingModel })

    const listedCount = capturedSystem.split('\n').filter(line => line.startsWith('- [other]')).length
    expect(listedCount).toBe(20)
    // validFrom 越大越新（实体24 最新，实体0 最旧），应保留最近的 20 条（实体5..实体24）
    expect(capturedSystem).toContain('- [other] 实体24 (messageId=')
    expect(capturedSystem).not.toContain('- [other] 实体0 (messageId=')
  })

  it('候选实体横跨多个 session（一次批处理同时处理多个角色）时，仍按全局最近排序，不会因为 session 遍历顺序被挤掉', async () => {
    // orchestrator.ts 的 getPendingEmbeddingMessages 是不分 session 的全局查询，一次 extractEntities
    // 调用经常会同时处理多个角色/session 的消息。loadCurrentEntityMaps 是逐个 session 各自查一遍
    // getCurrentEntities 再拼接，数组只在"每个 session 自己的那一段"内部有序——sessionA 有 20 条
    // 较旧的 'other' 实体排在数组前面，sessionB 只有 1 条但更新，如果不显式重新排序，
    // slice(0,20) 会直接被 sessionA 填满，把 sessionB 那条明明更新的实体挤掉
    for (let i = 0; i < 20; i++) {
      insertEntity({ messageId: i + 1, sessionId: 'sessionA', type: 'other', value: `A实体${i}`, validFrom: 1000 + i })
    }
    insertEntity({ messageId: 21, sessionId: 'sessionB', type: 'other', value: 'B实体最新', validFrom: 5000 })

    const msgA = addMessage('sessionA', '随便聊聊', 100000)
    const msgB = addMessage('sessionB', '随便聊聊', 100000)

    let capturedSystem = ''
    const capturingModel: EntityModelProvider = {
      async completeSync(context) {
        capturedSystem = context.system
        return '{"changes":[]}'
      },
    }

    await extractEntities([msgA, msgB], { ner: emptyNer(), model: capturingModel })

    expect(capturedSystem).toContain('B实体最新')
  })
})
