// src/settings/voiceTestSummary.ts — 语音自由测试结束后的统计：判为主人 / 其他人的句数与得分的最低、中位、最高，、单句得分对照的分数线，以及结果列表中要插入的麦克风行
// 用法：VoicePanel 调 summarizeVoiceTest(results)、testCutoff(result, uncertainFloor)、deviceLineBetween(previous, current)
// 对应文件：src/settings/VoicePanel.tsx / src/settings/voiceTestSummary.test.ts
export interface VoiceTestResultLike {
  kind: 'owner' | 'other' | 'unenrolled'
  score?: number
}

export interface VoiceCutoffInput {
  score?: number
  threshold?: number
  uncertain: boolean
  sameDevice?: boolean
}

export function testCutoff(result: VoiceCutoffInput, uncertainFloor: number | null | undefined): number | null {
  if (typeof result.score !== 'number') return null
  let cutoff: number | null | undefined
  if (!result.uncertain) cutoff = result.threshold
  else if (result.sameDevice === true) cutoff = uncertainFloor
  else if (result.sameDevice === false) cutoff = result.threshold
  return typeof cutoff === 'number' ? cutoff : null
}

export interface VoiceDeviceInput {
  deviceName?: string
  sameDevice?: boolean
}

export interface VoiceDeviceLine {
  from?: { name: string; sameDevice?: boolean }
  to: { name: string; sameDevice?: boolean }
}

export function deviceLineBetween(previous: VoiceDeviceInput | null, current: VoiceDeviceInput): VoiceDeviceLine | null {
  if (!current.deviceName) return null
  const to = { name: current.deviceName, sameDevice: current.sameDevice }
  if (previous === null) return { to }
  if (previous.deviceName === current.deviceName && previous.sameDevice === current.sameDevice) return null
  if (!previous.deviceName) return { to }
  return { from: { name: previous.deviceName, sameDevice: previous.sameDevice }, to }
}

export interface VoiceTestSummary {
  ownerCount: number
  otherCount: number
  minScore: number | null
  medianScore: number | null
  maxScore: number | null
}

function pick(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

export function summarizeVoiceTest(results: VoiceTestResultLike[]): VoiceTestSummary {
  const ownerCount = results.filter(r => r.kind === 'owner').length
  const scores = results
    .map(r => r.score)
    .filter((s): s is number => typeof s === 'number')
    .sort((a, b) => a - b)
  return {
    ownerCount,
    otherCount: results.length - ownerCount,
    minScore: pick(scores, 0),
    medianScore: pick(scores, 0.5),
    maxScore: pick(scores, 0.999),
  }
}
