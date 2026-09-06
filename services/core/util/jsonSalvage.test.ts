import { describe, it, expect } from 'vitest'
import { parseJsonSalvage } from './jsonSalvage.js'

describe('parseJsonSalvage', () => {
  it('干净的 JSON：直接解析成功', () => {
    expect(parseJsonSalvage('{"reply":"你好","emote":"happy"}')).toEqual({ reply: '你好', emote: 'happy' })
  })

  it('```json 代码块包裹：解析出块内 JSON', () => {
    const raw = '```json\n{"reply":"你好"}\n```'
    expect(parseJsonSalvage(raw)).toEqual({ reply: '你好' })
  })

  it('裸 ``` 代码块包裹（无 json 标签）：解析出块内 JSON', () => {
    const raw = '```\n{"reply":"你好"}\n```'
    expect(parseJsonSalvage(raw)).toEqual({ reply: '你好' })
  })

  it('JSON 前带说明性文字：贪婪花括号匹配兜底解析成功', () => {
    const raw = "Sure! Here's the reply: {\"reply\":\"你好\"}"
    expect(parseJsonSalvage(raw)).toEqual({ reply: '你好' })
  })

  it('JSON 后带说明性文字：贪婪花括号匹配兜底解析成功', () => {
    const raw = '{"reply":"你好"} 以上就是回复内容。'
    expect(parseJsonSalvage(raw)).toEqual({ reply: '你好' })
  })

  it('截断、永远不闭合的对象：干净失败，返回 undefined，不抛错', () => {
    const raw = '{"reply":"这句话说到一半就断'
    expect(() => parseJsonSalvage(raw)).not.toThrow()
    expect(parseJsonSalvage(raw)).toBeUndefined()
  })

  it('代码块围栏未闭合（只有开头没有结尾）：干净失败，返回 undefined', () => {
    const raw = '```json\n{"reply":"没写完'
    expect(parseJsonSalvage(raw)).toBeUndefined()
  })

  it('包含花括号但不是合法 JSON 的普通文字：返回 undefined', () => {
    expect(parseJsonSalvage('今天天气 { 不错 } 呀，出去走走吧')).toBeUndefined()
  })

  it('完全不含花括号的普通文字：返回 undefined', () => {
    expect(parseJsonSalvage('不是 JSON 的普通回复')).toBeUndefined()
  })

  it('嵌套花括号（代码块内的合法嵌套对象）：正确解析出完整嵌套结构', () => {
    const raw = '```json\n{"reply":"你好","emotion":{"self":{"label":"happy","intensity":0.7}}}\n```'
    expect(parseJsonSalvage(raw)).toEqual({
      reply: '你好',
      emotion: { self: { label: 'happy', intensity: 0.7 } },
    })
  })

  it('嵌套花括号（无代码块围栏，真正对象前混入一段无关的花括号说明文字）：贪婪匹配拼出的字符串本身不是合法 JSON，干净失败而不是解析出错误结构', () => {
    // 贪婪匹配会从第一个 { 一路匹配到最后一个 }，把中间这段普通文字也吞进去，
    // 拼出来的整串不是合法 JSON 语法，因此在 JSON.parse 这一步就会失败——
    // 不会把"张三说的话"错当成解析结果的一部分吐给调用方
    const raw = '张三说了句「{ 你好 }」，实际回复是 {"reply":"真正的回复"}'
    expect(parseJsonSalvage(raw)).toBeUndefined()
  })

  it('两个围栏代码块：先复述格式示例再给真正回复——取最后一个块（真正回复），不是第一个（示例）', () => {
    const raw = [
      '格式示例：',
      '```json',
      '{"reply": "示例文字", "emotion": {"self": {"label":"happy","intensity":0.5}}}',
      '```',
      '真正回复：',
      '```json',
      '{"reply": "你好呀，最近如何？", "emotion": {"self": {"label":"curious","intensity":0.7}}}',
      '```',
    ].join('\n')
    expect(parseJsonSalvage(raw)).toEqual({
      reply: '你好呀，最近如何？',
      emotion: { self: { label: 'curious', intensity: 0.7 } },
    })
  })

  it('两个围栏代码块，最后一个被截断（未闭合、块内 JSON 也不完整）：回退到更早的合法块，而不是整体失败', () => {
    const raw = [
      '```json',
      '{"reply": "第一个块，合法"}',
      '```',
      '```json',
      '{"reply": "第二个块，写到一半就断',
    ].join('\n')
    // 第二个 ``` 只有开头没有闭合，围栏正则本身就匹配不到这个块（不会进入候选列表）——
    // 候选列表里只剩第一个合法块，回退到它并解析成功
    expect(parseJsonSalvage(raw)).toEqual({ reply: '第一个块，合法' })
  })

  it('已知限制：围栏代码块（格式示例）后面紧跟不带围栏的真正回复——本函数只在围栏块内部按顺序回退，不会跨到围栏之外，因此仍会选中围栏块（示例），而不是围栏外真正的回复', () => {
    // 这是本次修复明确未覆盖的场景（见 jsonSalvage.ts 顶部大注释「已知的局限」一节）：
    // 真正答案完全落在围栏之外时，第 2 步（围栏块候选）压根不知道它的存在；第 3 步的
    // 贪婪匹配又会把围栏块里的 { 和围栏外真正回复的 } 一起吞进同一次匹配，拼出的整串
    // 不是合法 JSON，同样解析失败——最终结果是选中了错误的围栏块，而不是彻底失败
    const raw = [
      '格式示例：',
      '```json',
      '{"reply": "示例文字"}',
      '```',
      '真正回复：{"reply": "真实回复"}',
    ].join('\n')
    expect(parseJsonSalvage(raw)).toEqual({ reply: '示例文字' })
  })

  it('贪婪花括号匹配遇到两个完整独立的 JSON 对象（无围栏、无夹杂文字，仅相邻）：拼接后不是单一合法 JSON 值，干净失败', () => {
    // 与"混入无关文字"是同一失败机制：JSON 顶层只能有一个值，两个相邻对象拼在一起
    // 违反这一点，JSON.parse 必然失败，不会误把其中一个当结果返回
    const raw = '{"reply":"第一个对象"}\n{"reply":"第二个对象"}'
    expect(parseJsonSalvage(raw)).toBeUndefined()
  })
})
