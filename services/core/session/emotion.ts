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
