// services/core/util/jsonSalvage.ts — 从夹杂文字或代码块的模型输出里尽量解析出 JSON
// 用法：parseJsonSalvage(raw) 依次尝试整段解析、从后往前逐个 ``` 代码块、首个 { 到末个 } 的片段，全部失败返回 undefined；chat.ts、session/emotion.ts、memory/entityExtractor.ts 调用
// 对应文件：services/core/routes/chat.ts / services/core/session/emotion.ts / services/core/memory/entityExtractor.ts / services/core/util/jsonSalvage.test.ts
const FENCED_BLOCK_PATTERN = /```(?:json)?\s*\n?([\s\S]*?)```/g
const GREEDY_BRACE_PATTERN = /\{[\s\S]*\}/

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function parseJsonSalvage(raw: string): unknown {
  const direct = tryParse(raw)
  if (direct !== undefined) return direct

  const fencedBlocks = [...raw.matchAll(FENCED_BLOCK_PATTERN)].map(m => m[1].trim())
  for (let i = fencedBlocks.length - 1; i >= 0; i--) {
    const parsed = tryParse(fencedBlocks[i])
    if (parsed !== undefined) return parsed
  }

  const braced = raw.match(GREEDY_BRACE_PATTERN)
  if (braced) {
    const parsed = tryParse(braced[0])
    if (parsed !== undefined) return parsed
  }

  return undefined
}
