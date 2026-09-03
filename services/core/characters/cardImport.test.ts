import { describe, it, expect } from 'vitest'
import { parseCharacterCard } from './cardImport.js'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// 构造一个"结构合法但不是真实可解码图片"的 PNG fixture：只需要 tEXt chunk 结构正确
// （长度前缀 + 类型 + keyword\0text + CRC），不需要真实的图像数据块——本模块的
// 解析逻辑只关心 tEXt chunk，不解码图像本身
function buildChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4) // 不校验 CRC，填 0 即可
  return Buffer.concat([length, typeBuf, data, crc])
}

function buildTextChunkData(keyword: string, text: string): Buffer {
  return Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0x00]), Buffer.from(text, 'latin1')])
}

function buildPngFixture(textChunks: { keyword: string; text: string }[]): Buffer {
  const chunks = textChunks.map(({ keyword, text }) => buildChunk('tEXt', buildTextChunkData(keyword, text)))
  const iend = buildChunk('IEND', Buffer.alloc(0))
  return Buffer.concat([PNG_SIGNATURE, ...chunks, iend])
}

function base64Json(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64')
}

const v2Card = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Mint',
    description: '一只薄荷绿的猫娘',
    personality: '开朗、爱撒娇',
    scenario: '在一间安静的咖啡馆里',
    mes_example: '<START>\n{{user}}: 你好\n{{char}}: 你好呀～<START>\n{{user}}: 在干嘛\n{{char}}: 在等你',
    system_prompt: '',
    creator_notes: '这是一段创作者备注，不该进入 systemPrompt',
    tags: ['猫娘', '治愈'],
    creator: 'someone',
    character_version: '1.0',
  },
}

describe('parseCharacterCard — V2 JSON', () => {
  it('完整字段映射：name/description/personality/scenario/mes_example 合成进 systemPrompt，tags/creator/creatorNotes 独立返回', () => {
    const result = parseCharacterCard(Buffer.from(JSON.stringify(v2Card), 'utf-8'))
    if ('error' in result) throw new Error(`expected success, got error: ${result.error}`)

    expect(result.name).toBe('Mint')
    expect(result.tags).toEqual(['猫娘', '治愈'])
    expect(result.creator).toBe('someone')
    expect(result.creatorNotes).toBe('这是一段创作者备注，不该进入 systemPrompt')
    // creator_notes 规范明令不得进入 prompt
    expect(result.systemPrompt).not.toContain('创作者备注')
    expect(result.systemPrompt).toContain('外貌与背景：一只薄荷绿的猫娘')
    expect(result.systemPrompt).toContain('性格：开朗、爱撒娇')
    expect(result.systemPrompt).toContain('场景设定：在一间安静的咖啡馆里')
    expect(result.systemPrompt).toContain('对话示例：')
    expect(result.avatarCandidate).toBeNull()
    expect(result.suggestedCharacterId).toBe('Mint')
  })

  it('<START> 分隔的 mes_example 按分隔符拆分，不在正文里残留 <START> 字面量', () => {
    const result = parseCharacterCard(Buffer.from(JSON.stringify(v2Card), 'utf-8'))
    if ('error' in result) throw new Error('expected success')

    expect(result.systemPrompt).not.toContain('<START>')
    // 拆分出的两段示例都应该出现（宏替换后 {{user}}/{{char}} 已被替换）
    expect(result.systemPrompt).toContain('你好呀～')
    expect(result.systemPrompt).toContain('在等你')
  })
})

describe('parseCharacterCard — V1 平铺 JSON', () => {
  it('无信封的六字段平铺卡片正确解析，无 V2 专属字段', () => {
    const v1Card = {
      name: '阿墨',
      description: '安静的男孩子',
      personality: '内向、体贴',
      scenario: '深夜的书房',
      first_mes: '晚上好',
      mes_example: '<START>\n{{user}}: 在吗\n{{char}}: 在的',
    }
    const result = parseCharacterCard(Buffer.from(JSON.stringify(v1Card), 'utf-8'))
    if ('error' in result) throw new Error(`expected success, got error: ${result.error}`)

    expect(result.name).toBe('阿墨')
    expect(result.tags).toEqual([])
    expect(result.creator).toBe('')
    expect(result.creatorNotes).toBe('')
    expect(result.characterVersion).toBe('')
    expect(result.systemPrompt).toContain('外貌与背景：安静的男孩子')
    expect(result.systemPrompt).toContain('性格：内向、体贴')
    expect(result.systemPrompt).toContain('场景设定：深夜的书房')
    expect(result.systemPrompt).toContain('在的')
  })
})

describe('parseCharacterCard — character_version', () => {
  it('V2 卡片设置了 character_version 时原样捕获', () => {
    const result = parseCharacterCard(Buffer.from(JSON.stringify(v2Card), 'utf-8'))
    if ('error' in result) throw new Error('expected success')

    expect(result.characterVersion).toBe('1.0')
  })

  it('V1 卡片没有 character_version 字段，不应崩溃，取值为空字符串', () => {
    const v1Card = {
      name: '阿墨',
      description: '',
      personality: '',
      scenario: '',
      first_mes: '',
      mes_example: '',
    }
    const result = parseCharacterCard(Buffer.from(JSON.stringify(v1Card), 'utf-8'))
    if ('error' in result) throw new Error('expected success')

    expect(result.characterVersion).toBe('')
  })
})

describe('parseCharacterCard — system_prompt/{{original}} 合并规则', () => {
  it('system_prompt 含 {{original}}：展开为默认模板正文，嵌入自定义文本内', () => {
    const card = {
      ...v2Card,
      data: { ...v2Card.data, system_prompt: '【自定义开头】\n{{original}}\n【自定义结尾】' },
    }
    const result = parseCharacterCard(Buffer.from(JSON.stringify(card), 'utf-8'))
    if ('error' in result) throw new Error('expected success')

    expect(result.systemPrompt).toContain('【自定义开头】')
    expect(result.systemPrompt).toContain('【自定义结尾】')
    expect(result.systemPrompt).toContain('外貌与背景：一只薄荷绿的猫娘')
  })

  it('system_prompt 不含 {{original}}：整体替换默认模板，默认模板被丢弃', () => {
    const card = {
      ...v2Card,
      data: { ...v2Card.data, system_prompt: '完全自定义的人设正文，不含占位符' },
    }
    const result = parseCharacterCard(Buffer.from(JSON.stringify(card), 'utf-8'))
    if ('error' in result) throw new Error('expected success')

    expect(result.systemPrompt).toBe('完全自定义的人设正文，不含占位符')
    expect(result.systemPrompt).not.toContain('外貌与背景')
  })

  it('system_prompt 全空白：等价于未提供，回退默认模板', () => {
    const card = { ...v2Card, data: { ...v2Card.data, system_prompt: '   ' } }
    const result = parseCharacterCard(Buffer.from(JSON.stringify(card), 'utf-8'))
    if ('error' in result) throw new Error('expected success')

    expect(result.systemPrompt).toContain('外貌与背景：一只薄荷绿的猫娘')
  })
})

describe('parseCharacterCard — 宏替换', () => {
  it('{{char}}/<BOT>（大小写不敏感）替换为卡片 name，{{user}} 替换为中性的「你」', () => {
    const card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Mint',
        description: '',
        personality: '',
        scenario: '',
        mes_example: '',
        system_prompt: '{{CHAR}} 喜欢和 {{User}} 聊天，<bot> 也喜欢猫',
        creator_notes: '',
        tags: [],
        creator: '',
        character_version: '',
      },
    }
    const result = parseCharacterCard(Buffer.from(JSON.stringify(card), 'utf-8'))
    if ('error' in result) throw new Error('expected success')

    expect(result.systemPrompt).toBe('Mint 喜欢和 你 聊天，Mint 也喜欢猫')
  })
})

describe('parseCharacterCard — PNG 内嵌', () => {
  it('ccv3 关键字优先于 chara：两者同时存在时使用 ccv3 的数据', () => {
    const ccv3Card = { ...v2Card, data: { ...v2Card.data, name: 'FromCcv3' } }
    const charaCard = { ...v2Card, data: { ...v2Card.data, name: 'FromChara' } }
    const png = buildPngFixture([
      { keyword: 'chara', text: base64Json(charaCard) },
      { keyword: 'ccv3', text: base64Json(ccv3Card) },
    ])

    const result = parseCharacterCard(png)
    if ('error' in result) throw new Error(`expected success, got error: ${result.error}`)

    expect(result.name).toBe('FromCcv3')
    // PNG 路径应带上原始图片字节作为可选 avatar 候选
    expect(result.avatarCandidate).toEqual(png)
  })

  it('只有 chara 关键字时回落使用它', () => {
    const png = buildPngFixture([{ keyword: 'chara', text: base64Json(v2Card) }])

    const result = parseCharacterCard(png)
    if ('error' in result) throw new Error(`expected success, got error: ${result.error}`)

    expect(result.name).toBe('Mint')
  })

  it('PNG 无任何匹配的 tEXt 块时返回清晰错误，不抛出异常', () => {
    const png = buildPngFixture([{ keyword: 'other-key', text: base64Json(v2Card) }])

    const result = parseCharacterCard(png)
    expect('error' in result).toBe(true)
  })

  it('PNG 信号匹配但完全没有 tEXt 块时返回清晰错误', () => {
    const png = Buffer.concat([PNG_SIGNATURE, buildChunk('IEND', Buffer.alloc(0))])

    const result = parseCharacterCard(png)
    expect('error' in result).toBe(true)
  })

  it('tEXt chunk 声明长度超出实际剩余 buffer（畸形/截断数据）时干净地返回错误，不抛出、不越界读取', () => {
    // 手工构造一个"长度前缀撒谎"的 chunk：声明长度 1000，但实际数据只有几个字节、
    // 后面也没有 CRC——这正是"长度声明超出剩余 buffer"这条边界检查要拦的场景，
    // 不能用 buildChunk（它总是按真实数据长度算出正确的长度前缀）
    const length = Buffer.alloc(4)
    length.writeUInt32BE(1000, 0)
    const typeBuf = Buffer.from('tEXt', 'ascii')
    const shortData = Buffer.from('keyword\x00short', 'latin1')
    const truncatedChunk = Buffer.concat([length, typeBuf, shortData])
    const png = Buffer.concat([PNG_SIGNATURE, truncatedChunk])

    const result = parseCharacterCard(png)
    // 视为"未找到"而不是抛错/挂起——边界检查生效后扫描直接停止，找不到 ccv3/chara
    expect('error' in result).toBe(true)
  })
})

describe('parseCharacterCard — suggestedCharacterId 兜底值', () => {
  it('name 清理后为空字符串（全 emoji/非 ASCII 安全字符）时，回退到非空的、文件系统安全的默认值', () => {
    const card = { ...v2Card, data: { ...v2Card.data, name: '🐱🐱🐱' } }
    const result = parseCharacterCard(Buffer.from(JSON.stringify(card), 'utf-8'))
    if ('error' in result) throw new Error('expected success')

    expect(result.suggestedCharacterId.length).toBeGreaterThan(0)
    expect(result.suggestedCharacterId).toMatch(/^[a-zA-Z0-9_-]+$/)
  })
})

describe('parseCharacterCard — 畸形输入', () => {
  it('非 PNG 且不是合法 JSON 时返回清晰错误，不抛出异常', () => {
    const result = parseCharacterCard(Buffer.from('这不是 JSON', 'utf-8'))
    expect('error' in result).toBe(true)
  })

  it('PNG 内嵌的 base64 解码出的内容不是合法 JSON 时返回清晰错误', () => {
    const png = buildPngFixture([{ keyword: 'ccv3', text: Buffer.from('not json', 'utf-8').toString('base64') }])

    const result = parseCharacterCard(png)
    expect('error' in result).toBe(true)
  })
})
