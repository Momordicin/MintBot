import type { EmotionLabel } from '../../../shared/types/index.js'

// 校验模型 JSON 输出里的 emotion.self 是否是合法的 EmotionLabel：
// label 必须是非空字符串，intensity 必须是 0-1 之间的 number
function isValidSelfLabel(self: unknown): self is EmotionLabel {
  return (
    typeof self === 'object' && self !== null &&
    typeof (self as any).label === 'string' &&
    (self as any).label.trim().length > 0 &&
    typeof (self as any).intensity === 'number' &&
    (self as any).intensity >= 0 && (self as any).intensity <= 1
  )
}

// 从模型原始回复文本中解析并校验 self 情绪；JSON 解析失败或字段不合法时返回 null（降级，不抛错）。
// 不处理 perceived_user —— Phase 2 基础版留空占位，调用方直接强制写 null。
export function parseSelfEmotion(rawModelReply: string): EmotionLabel | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawModelReply)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const self = (parsed as any).emotion?.self
  return isValidSelfLabel(self) ? { label: self.label, intensity: self.intensity } : null
}

// 从模型原始回复文本中解析 emote 字段：与 parseSelfEmotion 同款的纯结构校验（这是否是一个
// 非空字符串），不做词表校验——emote 是否在角色包 emoteTagVocabulary 内、以及过滤 emotePool
// 选文件，都是调用方（chat.ts）按 TDD §3.9「表情包挑选机制」要做的下一步，本函数只负责给出
// 干净的结构化信号。模型没有输出该字段（本轮不附表情）与字段类型不合法，都返回 null，不区分。
export function parseEmoteTag(rawModelReply: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawModelReply)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const emote = (parsed as any).emote
  return typeof emote === 'string' && emote.trim().length > 0 ? emote : null
}
