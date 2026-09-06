import { insertEntity, getCurrentEntities, closeEntity } from '../session/queries.js'
import type { NERProvider } from '../providers/NERProvider.js'
import type { Message, MessageEntity, BuiltContext, CompletionOptions } from '../../../shared/types/index.js'
import { parseJsonSalvage } from '../util/jsonSalvage.js'

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
//
// Layer 3 明确只做"实体变更检测"这一件事，不再抽取技术词汇（编程语言/框架/工具）——
// 这是经过讨论确认的产品决定，不是遗漏：技术词一旦抽取成 type:'other' 实体就永远不会
// 被 closeEntity() 关闭失效，会无限期累积，还会混进 buildContext.ts 的"已知的用户信息"
// 人格化注入里，把"用户提到过某个技术词"当成类似"用户喜欢猫"这样的个人事实注入，
// 可能让角色表现出不必要的技术偏好，对陪伴对话的目的不利。不迁移到别的表维护——
// message_fts 已经对每条消息全文做关键词索引，之后如果用户问起某个技术词，FTS 召回
// 路径本来就能命中当年提到过这个词的原话，不需要额外维护一份技术词表。

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

export const VALID_TYPES = new Set<MessageEntity['type']>(['person', 'event', 'preference', 'place', 'other'])

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

// Layer 3 判断"实体变更"时，不把全量当前有效实体塞进 prompt（长期使用下会无限增长），
// 按 type 分组各自只保留最近 N 条。
//
// 不能按"这批新消息原文是否提到了候选实体的值"做子串匹配预筛——那样筛的是错误方向：
// 实体变更场景下用户说的是新事实本身（"我现在在新公司上班了"），新消息里天然不会出现
// 旧实体的值（"旧公司"），子串匹配会把恰恰需要拿来对比的旧值过滤掉，导致 Layer 3
// 最核心的"检测变更"能力几乎失效。因此只按 type + 最近 N 条兜底，不做额外的相关性过滤——
// 唯一的已知残留风险是：如果某个 type 在这次待更新的旧实体之后又新增了超过 N 条同 type
// 记录，旧实体会被挤出候选列表而漏检。这是一个可接受的、范围更小的边界情况（需要同一
// type 短期内堆积很多条记录），不是"几乎总是漏检"这种量级的问题
//
// 显式按 validFrom 降序排序后再分组截断，不依赖"调用方传入的数组已经整体按时间排好"这个
// 假设——orchestrator.ts 的 getPendingEmbeddingMessages 是不分 session 的全局查询，一次
// extractEntities 调用经常会处理横跨多个角色/session 的消息批次，而 loadCurrentEntityMaps
// 是逐个 session 各自查一遍 getCurrentEntities 再拼接进同一个数组的——数组只在"每个 session
// 自己的那一段"内部有序，整体不是全局按时间排序。如果不重新排序就直接按 type 分组 slice，
// 排在数组前面的 session（不一定更新）会挤掉后面 session 里真正更新的同类型实体
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

// 输出 JSON 结构：
// {
//   "changes": [{ "messageId": number, "type": "person"|"event"|"preference"|"place"|"other",
//                  "oldValue": string, "newValue": string }]
// }
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

// 防御性解析：模型可能返回带 markdown 代码块包裹的 JSON，也可能返回完全畸形的内容。
// 解析兜底逻辑集中在 util/jsonSalvage.ts（chat.ts / session/emotion.ts 共用同一份实现，
// 不再各自维护一份贪婪花括号正则）。任何解析失败都会向上抛出，由调用方捕获后跳过整个 Layer 3。
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

  // Layer 3: 主模型批量异步（实体变更判断）
  let changes: Layer3Change[] = []
  try {
    const context = buildLayer3Context(userMessages, selectLayer3Candidates(currentEntitiesForPrompt))
    // 不显式传 maxTokens：deps.model 在 index.ts 组装时已经用 backgroundModelProvider 配置
    // 构造好了（ModelProvider.resolveMaxTokens 的三级 fallback），这里不传等价于沿用那份配置
    // 里的 maxTokens——理由同 summarizer.ts generateSummary。此前这里显式读取
    // getBackgroundModelProviderConfig() 还有个副作用：未配置模型时它会抛出，而这里的 try/catch
    // 只是为了兜底"Layer 3 这一步可选失败"，会把"没配置模型"这种应当可见的状态误吞成
    // 一次无声跳过——现在不再读取，这个误吞连带消失
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
