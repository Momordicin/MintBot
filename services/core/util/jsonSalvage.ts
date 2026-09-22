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
