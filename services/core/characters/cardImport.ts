import crypto from 'crypto'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function isPng(buffer: Buffer): boolean {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)
}

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
    systemPromptRaw: isV2 ? str(data.system_prompt) : '',
    creatorNotes: isV2 ? str(data.creator_notes) : '',
    tags: isV2 && isStringArray(data.tags) ? data.tags : [],
    creator: isV2 ? str(data.creator) : '',
    characterVersion: isV2 ? str(data.character_version) : '',
  }
}

function parseMesExample(mesExample: string): string[] {
  return mesExample
    .split('<START>')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0)
}

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

function mergeSystemPrompt(card: NormalizedCard): string {
  const template = composeTemplate(card)
  const rawSystemPrompt = card.systemPromptRaw.trim()

  if (!rawSystemPrompt) return template
  if (rawSystemPrompt.includes('{{original}}')) {
    return rawSystemPrompt.split('{{original}}').join(template)
  }
  return rawSystemPrompt
}

function applyMacros(text: string, charName: string): string {
  return text
    .replace(/\{\{char\}\}/gi, charName)
    .replace(/<BOT>/gi, charName)
    .replace(/\{\{user\}\}/gi, '你')
}

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
  description: string
  personality: string
  scenario: string
  mesExample: string
  systemPromptRaw: string
}

export type ParseCharacterCardResult = ParsedCharacterCard | { error: string }

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
