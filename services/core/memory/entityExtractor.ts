import { insertEntity, getCurrentEntities, closeEntity } from '../session/queries.js'
import type { NERProvider } from '../providers/NERProvider.js'
import type { Message, MessageEntity, BuiltContext, CompletionOptions } from '../../../shared/types/index.js'

// 三层实体抽取（TDD §3.8 原子记忆提取 / §3.6 实体聚合结果加密）。
// 只负责"给定一批消息 → 抽取实体 → 双时态落库"，不负责触发时机（整理模式调度、
// pendingCount/oldestPendingAge 判断、cron）——这些由整理模式编排器（后续实现）负责，
// 编排器决定何时收集哪些消息调用本模块。
//
// 只处理 role === 'user' 的消息：记忆系统要记住的是"用户说过的事"（Phase 2 目标），
// 助手自己的回复不作为事实来源。
//
// 三层各自独立失败：规则层本地同步执行，无外部依赖，不设失败兜底；NER 层和主模型层
// 分别包一层 try/catch，任一层抛出 / 超时 / 返回畸形数据时记录日志并跳过该层，
// 不影响其余层已收集的结果写入。

// NER 结果 label → MessageEntity.type 映射（本模块负责，NerEntity.label 原始语义见
// shared/types/index.ts 的注释）：
//   PER（人名）  → person      人名本身就是"人"类实体
//   LOC（地点）  → place       地点直接对应 place
//   ORG（机构）  → other       机构（公司/学校/政府等）不完全等同人 / 地点 / 偏好，归入 other
//   TIME（时间） → event       时间提及大多伴随事件语境（"下周三"、"生日那天"），归入 event
const NER_LABEL_TO_TYPE: Record<string, MessageEntity['type'] | undefined> = {
  PER: 'person',
  LOC: 'place',
  ORG: 'other',
  TIME: 'event',
}

// 规则层（Layer 1）匹配的角色关键词，用于"我的{关系}是/叫 X"
const RELATION_ROLES = [
  '爸爸', '妈妈', '老公', '老婆', '男朋友', '女朋友',
  '哥哥', '姐姐', '弟弟', '妹妹', '同事', '老板', '朋友', '同学', '室友',
  '儿子', '女儿', '家人',
]

// 规则层匹配的常见职业关键词，用于"我是{职业}"
const JOB_TITLES = [
  '工程师', '设计师', '医生', '老师', '律师', '会计师', '程序员',
  '经理', '销售', '护士', '警察', '司机', '顾问', '作家', '演员', '记者',
]

// 句子截断字符（中文全角 + 常见标点），规则层匹配到关键词后向后截取到此处为止
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

interface Layer3TechTerm {
  messageId: number
  value: string
}

interface Layer3Change {
  messageId: number
  type: MessageEntity['type']
  oldValue: string
  newValue: string
}

// 主模型只需要 completeSync（非流式），单独定义窄接口便于测试注入假实现，
// 无需依赖 ModelProvider 类的私有字段（结构化类型无法用对象字面量满足含私有成员的类类型）
export interface EntityModelProvider {
  completeSync(context: BuiltContext, options?: CompletionOptions): Promise<string>
}

const VALID_TYPES = new Set<MessageEntity['type']>(['person', 'event', 'preference', 'place', 'other'])

function normalize(value: string): string {
  return value.trim()
}

function entityKey(type: MessageEntity['type'], value: string): string {
  return `${type}:${normalize(value)}`
}

// ─── Layer 1: 规则（本地同步，无外部依赖） ───────────────────────

function extractRuleEntities(msg: Message): EntityCandidate[] {
  const candidates: EntityCandidate[] = []
  const content = msg.content

  // 偏好："我喜欢/爱/讨厌/不喜欢 X" → preference，value 保留动词以保留正负极性（如"讨厌加班"）
  const preferenceMatch = content.match(PREFERENCE_PATTERN)
  if (preferenceMatch) {
    const value = normalize(`${preferenceMatch[1]}${preferenceMatch[2]}`)
    if (value) {
      candidates.push({ messageId: msg.id, sessionId: msg.sessionId, type: 'preference', value, validFrom: msg.createdAt })
    }
  }

  // 关系："我的{家人/朋友/同事/老板/...}是/叫 X" → person（人本身即人物实体）
  const relationMatch = content.match(RELATION_PATTERN)
  if (relationMatch) {
    const role = relationMatch[1]
    const name = normalize(relationMatch[2])
    if (name) {
      candidates.push({ messageId: msg.id, sessionId: msg.sessionId, type: 'person', value: `${role}:${name}`, validFrom: msg.createdAt })
    }
  }

  // 工作："我在 X 工作/上班" → other（工作单位归入 other，非物理地点意义上的 place）
  const workPlaceMatch = content.match(WORK_PLACE_PATTERN)
  if (workPlaceMatch) {
    const place = normalize(workPlaceMatch[1])
    if (place) {
      candidates.push({ messageId: msg.id, sessionId: msg.sessionId, type: 'other', value: `工作单位:${place}`, validFrom: msg.createdAt })
    }
  }

  // 工作："我是{职业}" → other
  const workJobMatch = content.match(WORK_JOB_PATTERN)
  if (workJobMatch) {
    candidates.push({ messageId: msg.id, sessionId: msg.sessionId, type: 'other', value: `职业:${workJobMatch[1]}`, validFrom: msg.createdAt })
  }

  // 工作："我的公司是 X" → other
  const workCompanyMatch = content.match(WORK_COMPANY_PATTERN)
  if (workCompanyMatch) {
    const company = normalize(workCompanyMatch[1])
    if (company) {
      candidates.push({ messageId: msg.id, sessionId: msg.sessionId, type: 'other', value: `公司:${company}`, validFrom: msg.createdAt })
    }
  }

  return candidates
}

// ─── Layer 3: 主模型批量异步 ─────────────────────────────────

// 输出 JSON 结构：
// {
//   "techTerms": [{ "messageId": number, "value": string }],
//   "changes": [{ "messageId": number, "type": "person"|"event"|"preference"|"place"|"other",
//                  "oldValue": string, "newValue": string }]
// }
function buildLayer3Context(userMessages: Message[], currentEntities: MessageEntity[]): BuiltContext {
  const currentEntitiesText = currentEntities.length
    ? currentEntities.map(e => `- [${e.type}] ${e.value} (messageId=${e.messageId})`).join('\n')
    : '(无)'

  const messagesText = userMessages.map(m => `[messageId=${m.id}] ${m.content}`).join('\n')

  const system = [
    '你是一个信息抽取助手，负责从用户消息中完成两项任务：',
    '1. 提取消息中出现的技术相关词汇（编程语言、框架、工具、专业术语等）。',
    '2. 判断消息中是否包含"实体变更"：用户提到的新事实是否取代了下方列出的某条已知当前有效实体',
    '（例如换工作、搬家、关系变化）。只有确信是同一实体的更新时才报告为变更，不确定时不要报告。',
    '',
    '已知当前有效实体：',
    currentEntitiesText,
    '',
    '严格只输出如下 JSON，不要包含任何其它文字或 markdown 代码块标记：',
    '{"techTerms":[{"messageId":number,"value":string}],"changes":[{"messageId":number,"type":"person"|"event"|"preference"|"place"|"other","oldValue":string,"newValue":string}]}',
  ].join('\n')

  return {
    system,
    messages: [{ role: 'user', content: messagesText }],
  }
}

function isValidTechTerm(t: unknown): t is Layer3TechTerm {
  return (
    typeof t === 'object' && t !== null &&
    typeof (t as any).messageId === 'number' &&
    typeof (t as any).value === 'string' &&
    normalize((t as any).value).length > 0
  )
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

// 防御性解析：模型可能返回带 markdown 代码块包裹的 JSON，也可能返回完全畸形的内容。
// 任何解析失败都会向上抛出，由调用方捕获后跳过整个 Layer 3。
function parseLayer3Response(raw: string): { techTerms: Layer3TechTerm[]; changes: Layer3Change[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('[EntityExtractor] layer3 response contains no JSON object')
    parsed = JSON.parse(match[0])
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('[EntityExtractor] layer3 response is not a JSON object')
  }

  const rawTechTerms = (parsed as any).techTerms
  const rawChanges = (parsed as any).changes

  const techTerms = Array.isArray(rawTechTerms) ? rawTechTerms.filter(isValidTechTerm) : []
  const changes = Array.isArray(rawChanges) ? rawChanges.filter(isValidChange) : []

  return { techTerms, changes }
}

// ─── 落库：去重 + 双时态 ─────────────────────────────────────

// 按 sessionId 缓存"当前有效实体" key → id 映射，用于去重和变更定位；
// 处理过程中随插入 / 关闭同步更新，保证同一批次内多层产出的候选也能互相去重
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

// 插入候选实体，若同 session + 同 type + 同 normalize(value) 已是当前有效实体则跳过（去重）
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

  // Layer 1: 规则（本地同步，始终执行）
  for (const msg of userMessages) {
    additiveCandidates.push(...extractRuleEntities(msg))
  }

  // Layer 2: NER
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

  // Layer 3: 主模型批量异步（技术词 + 实体变更）
  let changes: Layer3Change[] = []
  try {
    const context = buildLayer3Context(userMessages, currentEntitiesForPrompt)
    const raw = await deps.model.completeSync(context, { maxTokens: 1000 })
    const parsed = parseLayer3Response(raw)

    const msgById = new Map(userMessages.map(m => [m.id, m]))
    for (const term of parsed.techTerms) {
      const msg = msgById.get(term.messageId)
      if (!msg) continue
      additiveCandidates.push({ messageId: msg.id, sessionId: msg.sessionId, type: 'other', value: normalize(term.value), validFrom: msg.createdAt })
    }
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
      // Layer 3 认为发生了变更，但在当前有效实体中找不到匹配的旧值——不确定归因，
      // 不做双时态关闭，仅把新事实作为普通新增写入，避免丢信息
      console.warn(
        `[EntityExtractor] layer3 flagged a change with no matching current entity (sessionId=${msg.sessionId}, type=${change.type}, oldValue=${change.oldValue}); inserting new value without closing old one`
      )
    }

    if (insertIfNew({ messageId: msg.id, sessionId: msg.sessionId, type: change.type, value: normalize(change.newValue), validFrom: msg.createdAt }, currentBySession)) {
      inserted++
    }
  }

  return { inserted, closed }
}
