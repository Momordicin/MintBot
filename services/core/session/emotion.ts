// services/core/session/emotion.ts — 从模型回复里的 &&词&& 标签取出情绪、表情，并去掉标签得到显示文字
// 用法：parseReplyTags(reply, emotionVocabulary, emoteTagVocabulary) 返回 { text, emotion, emote }；POST /chat 对完整回复调用
// 对应文件：services/core/routes/chat.ts / services/core/session/emotion.test.ts
import type { EmotionLabel } from '../../../shared/types/index.js'

const TAG_PATTERN = /&&([^&\r\n]{1,64})&&/g
const DEFAULT_INTENSITY = 0.7

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
  const words = Array.from(reply.matchAll(TAG_PATTERN), m => m[1].trim())
  const emotionWord = words.find(w => emotionVocabulary.includes(w))
  const emote = words.find(w => emoteTagVocabulary.includes(w)) ?? null
  return {
    text: reply.replace(TAG_PATTERN, '').trim(),
    emotion: emotionWord === undefined ? null : { label: emotionWord, intensity: DEFAULT_INTENSITY },
    emote,
  }
}
