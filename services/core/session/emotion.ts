// services/core/session/emotion.ts — 从模型原始回复里取出角色自身情绪与表情标签
// 用法：parseSelfEmotion(rawModelReply) 返回 { label, intensity（0–1） } 或 null；parseEmoteTag(rawModelReply) 返回 emote 字符串或 null；POST /chat 对完整回复调用
// 形状：输入为经 parseJsonSalvage 解析的 JSON { emotion: { self: { label, intensity } }, emote }
// 对应文件：services/core/routes/chat.ts / services/core/util/jsonSalvage.ts / services/core/session/emotion.test.ts
import type { EmotionLabel } from '../../../shared/types/index.js'
import { parseJsonSalvage } from '../util/jsonSalvage.js'

function isValidSelfLabel(self: unknown): self is EmotionLabel {
  return (
    typeof self === 'object' && self !== null &&
    typeof (self as any).label === 'string' &&
    (self as any).label.trim().length > 0 &&
    typeof (self as any).intensity === 'number' &&
    (self as any).intensity >= 0 && (self as any).intensity <= 1
  )
}

export function parseSelfEmotion(rawModelReply: string): EmotionLabel | null {
  const parsed = parseJsonSalvage(rawModelReply)
  if (typeof parsed !== 'object' || parsed === null) return null
  const self = (parsed as any).emotion?.self
  return isValidSelfLabel(self) ? { label: self.label, intensity: self.intensity } : null
}

export function parseEmoteTag(rawModelReply: string): string | null {
  const parsed = parseJsonSalvage(rawModelReply)
  if (typeof parsed !== 'object' || parsed === null) return null
  const emote = (parsed as any).emote
  return typeof emote === 'string' && emote.trim().length > 0 ? emote : null
}
