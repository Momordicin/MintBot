// src/settings/voiceTestSummary.ts — 语音自由测试结束后的统计：判为主人 / 其他人的句数与得分的最低、中位、最高
// 用法：VoicePanel 调 summarizeVoiceTest(results)
// 对应文件：src/settings/VoicePanel.tsx / src/settings/voiceTestSummary.test.ts
export interface VoiceTestResultLike {
  kind: 'owner' | 'other' | 'unenrolled'
  score?: number
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
