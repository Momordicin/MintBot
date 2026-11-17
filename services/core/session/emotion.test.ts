import { describe, it, expect } from 'vitest'
import { parseReplyTags } from './emotion.js'

const EMOTIONS = ['happy', 'curious', 'shy']
const EMOTES = ['playful', 'comforting']

describe('parseReplyTags', () => {
  it.each([
    { name: '情绪标签在末尾', reply: '今天怎么样？\n&&curious&&', text: '今天怎么样？', emotion: 'curious', emote: null },
    { name: '情绪加表情，各占一行', reply: '好呀\n&&happy&&\n&&playful&&', text: '好呀', emotion: 'happy', emote: 'playful' },
    { name: '标签内外有空白，取词时去掉首尾空白', reply: '好呀\n&& happy &&', text: '好呀', emotion: 'happy', emote: null },
    { name: '多个情绪标签取第一个词表内的', reply: '嗯\n&&unknown&&&&shy&&&&happy&&', text: '嗯', emotion: 'shy', emote: null },
    { name: '不在词表里的标签也从文字里删掉，情绪与表情为 null', reply: '你好&&other&&呀', text: '你好呀', emotion: null, emote: null },
    { name: '没有标签：文字原样（去首尾空白），情绪与表情为 null', reply: '  你好  ', text: '你好', emotion: null, emote: null },
    { name: '标签写在正文中间也被识别并删除', reply: '你&&happy&&好', text: '你好', emotion: 'happy', emote: null },
    { name: '标签词含换行不算标签', reply: '你好&&hap\npy&&', text: '你好&&hap\npy&&', emotion: null, emote: null },
    { name: '标签词超过 64 个字符不算标签', reply: `你好&&${'a'.repeat(65)}&&`, text: `你好&&${'a'.repeat(65)}&&`, emotion: null, emote: null },
    { name: '情绪词只出现在表情词表里：不当作情绪', reply: '好\n&&playful&&', text: '好', emotion: null, emote: 'playful' },
    { name: '末尾两行单独的词表词当作情绪与表情', reply: '好呀\n\ncurious\n\ncomforting', text: '好呀', emotion: 'curious', emote: 'comforting' },
    { name: '末尾单独的词不区分大小写，取词表里的写法', reply: '好呀\r\n Happy ', text: '好呀', emotion: 'happy', emote: null },
    { name: '&& 标签优先于末尾单独的词', reply: '好呀\n&&shy&&\nhappy', text: '好呀', emotion: 'shy', emote: null },
    { name: '末尾单独的词不在词表里：原样保留', reply: '好呀\nconfused', text: '好呀\nconfused', emotion: null, emote: null },
    { name: '末尾一行带其它字符：原样保留', reply: '好呀\nhappy!', text: '好呀\nhappy!', emotion: null, emote: null },
    { name: '只看最后两行非空行', reply: '好呀\nhappy\nshy\nplayful', text: '好呀\nhappy', emotion: 'shy', emote: 'playful' },
    { name: '遇到不是词表词的一行就停，正文中间的词不动', reply: 'happy\n今天不错\nshy', text: 'happy\n今天不错', emotion: 'shy', emote: null },
  ])('$name', ({ reply, text, emotion, emote }) => {
    expect(parseReplyTags(reply, EMOTIONS, EMOTES)).toEqual({
      text,
      emotion: emotion === null ? null : { label: emotion, intensity: 0.7 },
      emote,
    })
  })

  it('词表为空：任何标签都不识别，但仍从文字里删除', () => {
    expect(parseReplyTags('你好\n&&happy&&', [], [])).toEqual({ text: '你好', emotion: null, emote: null })
  })
})
