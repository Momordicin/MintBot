// services/core/session/emotion.ts — 从模型回复里的 &&词&& 标签与末尾单独成行的词表词取出情绪、表情，并去掉它们得到显示文字
// 用法：parseReplyTags(reply, emotionVocabulary, emoteTagVocabulary) 返回 { text, emotion, emote }；POST /chat 对完整回复调用
// 对应文件：services/core/routes/chat.ts / services/core/session/emotion.test.ts
import type { EmotionLabel } from '../../../shared/types/index.js'

const TAG_PATTERN = /&&([^&\r\n]{1,64})&&/g
const DEFAULT_INTENSITY = 0.7
const TRAILING_LINE_LIMIT = 2

export interface ParsedReplyTags {
  text: string
  emotion: EmotionLabel | null
  emote: string | null
}

export function parseReplyTags(
  reply: string,
  emotionVocabulary: readonly string[],
  emoteTagVocabulary: readonly string[]
): ParsedReplyTags {
  const tagWords = Array.from(reply.matchAll(TAG_PATTERN), m => m[1].trim())
  const lines = reply.replace(TAG_PATTERN, '').split('\n')
  const trailingWords: string[] = []
  let end = lines.length
  let checked = 0
  for (let i = lines.length - 1; i >= 0 && checked < TRAILING_LINE_LIMIT; i--) {
    const line = lines[i].trim()
    if (line === '') continue
    checked++
    const word = [...emotionVocabulary, ...emoteTagVocabulary].find(w => w.toLowerCase() === line.toLowerCase())
    if (word === undefined) break
    trailingWords.unshift(word)
    end = i
  }
  const words = [...tagWords, ...trailingWords]
  const emotionWord = words.find(w => emotionVocabulary.includes(w))
  const emote = words.find(w => emoteTagVocabulary.includes(w)) ?? null
  return {
    text: lines.slice(0, end).join('\n').trim(),
    emotion: emotionWord === undefined ? null : { label: emotionWord, intensity: DEFAULT_INTENSITY },
    emote,
  }
}
