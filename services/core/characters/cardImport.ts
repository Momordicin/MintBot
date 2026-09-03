import crypto from 'crypto'

// 角色卡导入：SillyTavern character card v2 解析 + 模板合成（docs/MintBot_TDD.md §3.7
// 附「角色卡导入」）。本模块只做"卡片字节 → 合成好的 systemPrompt"这一段纯逻辑（除
// JSON.parse/base64 解码外无 I/O），不碰数据库/文件系统——落盘（POST /presets、
// avatar 上传）由 routes/characterImport.ts 负责。
//
// 结构化字段本轮不落库（TDD 原文）：这里合成出的 systemPrompt 是最终产物，调用方
// 不应该指望还能拿回 description/personality/scenario 单独持久化，本模块导出这些
// 原始字段只是为了让路由层能转发给"模型辅助生成"这条备选路径重新生成一遍。

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function isPng(buffer: Buffer): boolean {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)
}

// 逐块扫描 tEXt chunk：[4字节大端长度][4字节 ASCII 类型][N 字节数据][4字节 CRC，不校验]。
// 数据格式为 keyword + 0x00 + text（PNG tEXt 规范，不是 EXIF）。遇到长度声明超出剩余
// buffer 的畸形数据时直接停止扫描（视为"未找到"，不抛错），遇到 IEND 也提前结束——
// 已经是文件末尾标记，之后不会再有 tEXt
function extractTextChunks(buffer: Buffer): Map<string, string> {
  const chunks = new Map<string, string>()
  let offset = 8

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buffer.length) break

    if (type === 'tEXt') {
      const data = buffer.subarray(dataStart, dataEnd)
      const nullIndex = data.indexOf(0x00)
      if (nullIndex !== -1) {
        const keyword = data.toString('latin1', 0, nullIndex)
        const text = data.toString('latin1', nullIndex + 1)
        chunks.set(keyword, text)
      }
    }

    offset = dataEnd + 4
    if (type === 'IEND') break
  }

  return chunks
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

interface NormalizedCard {
  name: string
  description: string
  personality: string
  scenario: string
  mesExample: string
  systemPromptRaw: string
  creatorNotes: string
  tags: string[]
  creator: string
  characterVersion: string
}

// V2 判据：有没有 spec/data 信封（spec_version 是字符串，本身不参与判断，TDD 原文只
// 用信封结构本身作为判据）。V1 六个字段平铺在顶层
function normalizeCard(raw: unknown): NormalizedCard {
  const envelope = (raw ?? {}) as Record<string, unknown>
  const isV2 = envelope.spec === 'chara_card_v2' && typeof envelope.data === 'object' && envelope.data !== null
  const data = (isV2 ? envelope.data : envelope) as Record<string, unknown>

  return {
    name: str(data.name),
    description: str(data.description),
    personality: str(data.personality),
    scenario: str(data.scenario),
    mesExample: str(data.mes_example),
    // system_prompt/creator_notes/tags/creator/character_version 是 V2 专属字段，
    // V1 没有信封也就没有这些字段
    systemPromptRaw: isV2 ? str(data.system_prompt) : '',
    creatorNotes: isV2 ? str(data.creator_notes) : '',
    tags: isV2 && isStringArray(data.tags) ? data.tags : [],
    creator: isV2 ? str(data.creator) : '',
    characterVersion: isV2 ? str(data.character_version) : '',
  }
}

// <START> 是分隔符，按分隔符解析后丢弃，不留在正文里；丢弃空白段
function parseMesExample(mesExample: string): string[] {
  return mesExample
    .split('<START>')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0)
}

// 默认模板合成：确定性、零模型调用，拼成可读的中文段落，每段清楚标注来自哪个卡片字段
function composeTemplate(card: NormalizedCard): string {
  const parts: string[] = []
  if (card.description.trim()) parts.push(`外貌与背景：${card.description.trim()}`)
  if (card.personality.trim()) parts.push(`性格：${card.personality.trim()}`)
  if (card.scenario.trim()) parts.push(`场景设定：${card.scenario.trim()}`)

  const examples = parseMesExample(card.mesExample)
  if (examples.length > 0) {
    parts.push(`对话示例：\n${examples.join('\n\n')}`)
  }

  return parts.join('\n\n')
}

// system_prompt/{{original}} 合并规则（TDD 原文，三种情况）：
// 1. 无 system_prompt（或全空白）→ 最终正文就是默认模板
// 2. 有 system_prompt 且含 {{original}} → 替换为默认模板（嵌入自定义正文内）
// 3. 有 system_prompt 且不含 {{original}} → system_prompt 整体替换默认模板（默认模板被丢弃，不是追加）
function mergeSystemPrompt(card: NormalizedCard): string {
  const template = composeTemplate(card)
  const rawSystemPrompt = card.systemPromptRaw.trim()

  if (!rawSystemPrompt) return template
  if (rawSystemPrompt.includes('{{original}}')) {
    return rawSystemPrompt.split('{{original}}').join(template)
  }
  return rawSystemPrompt
}

// 宏替换：在合并之后的最终文本上一次性替换，不引入运行时模板层（TDD 原文——systemPrompt
// 是用户可自由编辑的所见即所得文本）。{{user}} 替换为中性的「你」——per-角色称呼
// （Presets.addressForms）编辑 UI 本轮不在范围内，这是 TDD 自己给出的无称呼兜底值
function applyMacros(text: string, charName: string): string {
  return text
    .replace(/\{\{char\}\}/gi, charName)
    .replace(/<BOT>/gi, charName)
    .replace(/\{\{user\}\}/gi, '你')
}

// characterId 建议值：只保留字母/数字/连字符/下划线；清理后为空（如纯中文名/纯符号名）
// 时回退到一个短随机后缀——只是预填值，用户提交前可在表单里自由修改
function deriveCharacterId(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '')
  if (cleaned) return cleaned
  return `card-${crypto.randomBytes(3).toString('hex')}`
}

export interface ParsedCharacterCard {
  name: string
  systemPrompt: string
  suggestedCharacterId: string
  tags: string[]
  creator: string
  creatorNotes: string
  characterVersion: string
  avatarCandidate: Buffer | null
  // 原始结构化字段，供路由层转发给"模型辅助生成"路径（POST /characters/import/generate）
  // 重新合成一遍；本轮不落库，见文件头注释
  description: string
  personality: string
  scenario: string
  mesExample: string
  systemPromptRaw: string
}

export type ParseCharacterCardResult = ParsedCharacterCard | { error: string }

// 三条格式分支入口：PNG 内嵌 → JSON 文本（V2/V1 都可能）→ 归一化 → 模板合成 + 宏替换。
// 失败一律返回 { error }，不抛错——这是用户发起的导入动作，路由层需要把清晰的错误信息
// 400 给用户，而不是让异常冒泡成通用 500（manifest.ts 的静默降级到 null 不适用于这里）
export function parseCharacterCard(buffer: Buffer): ParseCharacterCardResult {
  let jsonText: string
  let avatarCandidate: Buffer | null = null

  if (isPng(buffer)) {
    const textChunks = extractTextChunks(buffer)
    const raw = textChunks.get('ccv3') ?? textChunks.get('chara')
    if (raw === undefined) {
      return { error: 'PNG 文件中未找到角色卡数据（缺少 ccv3/chara 文本块）' }
    }
    try {
      jsonText = Buffer.from(raw, 'base64').toString('utf-8')
    } catch {
      return { error: '角色卡数据 base64 解码失败' }
    }
    avatarCandidate = buffer
  } else {
    jsonText = buffer.toString('utf-8')
  }

  let raw: unknown
  try {
    raw = JSON.parse(jsonText)
  } catch {
    return { error: '角色卡 JSON 解析失败，文件已损坏或格式不受支持' }
  }

  const card = normalizeCard(raw)
  const template = mergeSystemPrompt(card)
  const systemPrompt = applyMacros(template, card.name)

  return {
    name: card.name,
    systemPrompt,
    suggestedCharacterId: deriveCharacterId(card.name),
    tags: card.tags,
    creator: card.creator,
    creatorNotes: card.creatorNotes,
    characterVersion: card.characterVersion,
    avatarCandidate,
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    mesExample: card.mesExample,
    systemPromptRaw: card.systemPromptRaw,
  }
}
