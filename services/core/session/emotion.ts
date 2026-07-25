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
