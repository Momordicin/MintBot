// services/core/memory/entityExtractor.ts — 从用户消息抽取实体写入 MessageEntities：正则规则 + NER 服务新增实体，后台模型判断"实体变更"并关闭被取代的旧实体
// 用法：orchestrator.ts 的 runOrganizeModeTick 对每批待嵌入消息调 extractEntities(messages, { ner, model })（model 即 backgroundModelProvider 的 completeSync）；导出 VALID_TYPES 供 routes/memory.ts 校验实体类型
// 形状：(Message[], { ner, model }) -> { inserted, closed }
// 对应文件：services/core/memory/orchestrator.ts / services/core/routes/memory.ts / services/core/providers/NERProvider.ts / services/core/util/jsonSalvage.ts / services/core/session/queries.ts / services/core/memory/entityExtractor.test.ts
import { insertEntity, getCurrentEntities, closeEntity } from '../session/queries.js'
import type { NERProvider } from '../providers/NERProvider.js'
import type { Message, MessageEntity, BuiltContext, CompletionOptions } from '../../../shared/types/index.js'
import { parseJsonSalvage } from '../util/jsonSalvage.js'

const NER_LABEL_TO_TYPE: Record<string, MessageEntity['type'] | undefined> = {
  PER: 'person',
  LOC: 'place',
  ORG: 'other',
  TIME: 'event',
}

const RELATION_ROLES = [
  '爸爸', '妈妈', '老公', '老婆', '男朋友', '女朋友',
  '哥哥', '姐姐', '弟弟', '妹妹', '同事', '老板', '朋友', '同学', '室友',
  '儿子', '女儿', '家人',
]

const JOB_TITLES = [
  '工程师', '设计师', '医生', '老师', '律师', '会计师', '程序员',
  '经理', '销售', '护士', '警察', '司机', '顾问', '作家', '演员', '记者',
]

const STOP_CHARS = '，。！？,.!?\n'
const STOP_CLASS = `[^${STOP_CHARS}]+`

const PREFERENCE_PATTERN = new RegExp(`我(喜欢|爱|讨厌|不喜欢|不爱)(${STOP_CLASS})`)
const RELATION_PATTERN = new RegExp(`我的(${RELATION_ROLES.join('|')})(?:叫|是)(${STOP_CLASS})`)
const WORK_PLACE_PATTERN = new RegExp(`我在(${STOP_CLASS}?)(?:工作|上班)`)
const WORK_JOB_PATTERN = new RegExp(`我是(?:一名|一个)?([\\u4e00-\\u9fa5]{2,8}(?:${JOB_TITLES.join('|')}))`)
const WORK_COMPANY_PATTERN = new RegExp(`我的公司是(${STOP_CLASS})`)

interface EntityCandidate {
  messageId: number
  sessionId: string
  type: MessageEntity['type']
  value: string
  validFrom: number
}

interface Layer3Change {
  messageId: number
  type: MessageEntity['type']
  oldValue: string
  newValue: string
}

export interface EntityModelProvider {
  completeSync(context: BuiltContext, options?: CompletionOptions): Promise<string>
}

export const VALID_TYPES = new Set<MessageEntity['type']>(['person', 'event', 'preference', 'place', 'other'])

function normalize(value: string): string {
  return value.trim()
}

function entityKey(type: MessageEntity['type'], value: string): string {
  return `${type}:${normalize(value)}`
}

function extractRuleEntities(msg: Message): EntityCandidate[] {
  const candidates: EntityCandidate[] = []
  const content = msg.content

  const preferenceMatch = content.match(PREFERENCE_PATTERN)
  if (preferenceMatch) {
    const value = normalize(`${preferenceMatch[1]}${preferenceMatch[2]}`)
    if (value) {
      candidates.push({ messageId: msg.id, sessionId: msg.sessionId, type: 'preference', value, validFrom: msg.createdAt })
    }
  }

  const relationMatch = content.match(RELATION_PATTERN)
  if (relationMatch) {
    const role = relationMatch[1]
    const name = normalize(relationMatch[2])
    if (name) {
      candidates.push({ messageId: msg.id, sessionId: msg.sessionId, type: 'person', value: `${role}:${name}`, validFrom: msg.createdAt })
    }
  }

  const workPlaceMatch = content.match(WORK_PLACE_PATTERN)
  if (workPlaceMatch) {
    const place = normalize(workPlaceMatch[1])
    if (place) {
      candidates.push({ messageId: msg.id, sessionId: msg.sessionId, type: 'other', value: `工作单位:${place}`, validFrom: msg.createdAt })
    }
  }

  const workJobMatch = content.match(WORK_JOB_PATTERN)
  if (workJobMatch) {
    candidates.push({ messageId: msg.id, sessionId: msg.sessionId, type: 'other', value: `职业:${workJobMatch[1]}`, validFrom: msg.createdAt })
  }

  const workCompanyMatch = content.match(WORK_COMPANY_PATTERN)
  if (workCompanyMatch) {
    const company = normalize(workCompanyMatch[1])
    if (company) {
      candidates.push({ messageId: msg.id, sessionId: msg.sessionId, type: 'other', value: `公司:${company}`, validFrom: msg.createdAt })
    }
  }

  return candidates
}

const LAYER3_MAX_CANDIDATES_PER_TYPE = 20

function selectLayer3Candidates(currentEntities: MessageEntity[]): MessageEntity[] {
  const byType = new Map<MessageEntity['type'], MessageEntity[]>()
  for (const e of currentEntities) {
    const list = byType.get(e.type) ?? []
    list.push(e)
    byType.set(e.type, list)
  }

  const capped: MessageEntity[] = []
  for (const list of byType.values()) {
    list.sort((a, b) => b.validFrom - a.validFrom)
    capped.push(...list.slice(0, LAYER3_MAX_CANDIDATES_PER_TYPE))
  }
  return capped
}

function buildLayer3Context(userMessages: Message[], currentEntities: MessageEntity[]): BuiltContext {
  const currentEntitiesText = currentEntities.length
    ? currentEntities.map(e => `- [${e.type}] ${e.value} (messageId=${e.messageId})`).join('\n')
    : '(无)'

  const messagesText = userMessages.map(m => `[messageId=${m.id}] ${m.content}`).join('\n')

  const system = [
    '你是一个信息抽取助手，负责从用户消息中判断是否包含"实体变更"：用户提到的新事实是否取代了下方列出的某条已知当前有效实体',
    '（例如换工作、搬家、关系变化）。只有确信是同一实体的更新时才报告为变更，不确定时不要报告。',
    '',
    '已知当前有效实体：',
    currentEntitiesText,
    '',
    '严格只输出如下 JSON，不要包含任何其它文字或 markdown 代码块标记：',
    '{"changes":[{"messageId":number,"type":"person"|"event"|"preference"|"place"|"other","oldValue":string,"newValue":string}]}',
  ].join('\n')

  return {
    system,
    messages: [{ role: 'user', content: messagesText }],
  }
}

function isValidChange(c: unknown): c is Layer3Change {
  return (
    typeof c === 'object' && c !== null &&
    typeof (c as any).messageId === 'number' &&
    VALID_TYPES.has((c as any).type) &&
    typeof (c as any).oldValue === 'string' &&
    typeof (c as any).newValue === 'string' &&
    normalize((c as any).oldValue).length > 0 &&
    normalize((c as any).newValue).length > 0
  )
}

function parseLayer3Response(raw: string): { changes: Layer3Change[] } {
  const parsed = parseJsonSalvage(raw)
  if (parsed === undefined) {
    throw new Error('[EntityExtractor] layer3 response contains no JSON object')
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('[EntityExtractor] layer3 response is not a JSON object')
  }

  const rawChanges = (parsed as any).changes
  const changes = Array.isArray(rawChanges) ? rawChanges.filter(isValidChange) : []

  return { changes }
}

function loadCurrentEntityMaps(sessionIds: string[]): { maps: Map<string, Map<string, number>>; all: MessageEntity[] } {
  const maps = new Map<string, Map<string, number>>()
  const all: MessageEntity[] = []
  for (const sessionId of sessionIds) {
    const current = getCurrentEntities(sessionId)
    const map = new Map<string, number>()
    for (const e of current) map.set(entityKey(e.type, e.value), e.id)
    maps.set(sessionId, map)
    all.push(...current)
  }
  return { maps, all }
}

function insertIfNew(cand: EntityCandidate, maps: Map<string, Map<string, number>>): boolean {
  let map = maps.get(cand.sessionId)
  if (!map) {
    map = new Map<string, number>()
    maps.set(cand.sessionId, map)
  }
  const key = entityKey(cand.type, cand.value)
  if (map.has(key)) return false

  const id = insertEntity({
    messageId: cand.messageId,
    sessionId: cand.sessionId,
    type: cand.type,
    value: cand.value,
    validFrom: cand.validFrom,
  })
  map.set(key, id)
  return true
}

export async function extractEntities(
  messages: Message[],
  deps: { ner: NERProvider; model: EntityModelProvider }
): Promise<{ inserted: number; closed: number }> {
  const userMessages = messages.filter(m => m.role === 'user')
  if (userMessages.length === 0) {
    return { inserted: 0, closed: 0 }
  }

  const sessionIds = [...new Set(userMessages.map(m => m.sessionId))]
  const { maps: currentBySession, all: currentEntitiesForPrompt } = loadCurrentEntityMaps(sessionIds)

  const additiveCandidates: EntityCandidate[] = []

  for (const msg of userMessages) {
    additiveCandidates.push(...extractRuleEntities(msg))
  }

  try {
    const nerResults = await deps.ner.extractBatch(userMessages.map(m => m.content))
    nerResults.forEach((entities, i) => {
      const msg = userMessages[i]
      for (const ent of entities) {
        const type = NER_LABEL_TO_TYPE[ent.label]
        if (!type) continue
        const value = normalize(ent.text)
        if (!value) continue
        additiveCandidates.push({ messageId: msg.id, sessionId: msg.sessionId, type, value, validFrom: msg.createdAt })
      }
    })
  } catch (err) {
    console.error('[EntityExtractor] NER layer failed, skipping:', err)
  }

  let changes: Layer3Change[] = []
  try {
    const context = buildLayer3Context(userMessages, selectLayer3Candidates(currentEntitiesForPrompt))
    const raw = await deps.model.completeSync(context)
    const parsed = parseLayer3Response(raw)
    changes = parsed.changes
  } catch (err) {
    console.error('[EntityExtractor] main-model layer failed, skipping:', err)
  }

  let inserted = 0
  for (const cand of additiveCandidates) {
    if (insertIfNew(cand, currentBySession)) inserted++
  }

  const msgById = new Map(userMessages.map(m => [m.id, m]))
  let closed = 0
  for (const change of changes) {
    const msg = msgById.get(change.messageId)
    if (!msg) continue

    const map = currentBySession.get(msg.sessionId) ?? new Map<string, number>()
    currentBySession.set(msg.sessionId, map)

    const oldKey = entityKey(change.type, change.oldValue)
    const oldId = map.get(oldKey)
    if (oldId !== undefined) {
      closeEntity(oldId)
      map.delete(oldKey)
      closed++
    } else {
      console.warn(
        `[EntityExtractor] layer3 flagged a change with no matching current entity (sessionId=${msg.sessionId}, type=${change.type}); inserting new value without closing old one`
      )
    }

    if (insertIfNew({ messageId: msg.id, sessionId: msg.sessionId, type: change.type, value: normalize(change.newValue), validFrom: msg.createdAt }, currentBySession)) {
      inserted++
    }
  }

  return { inserted, closed }
}
