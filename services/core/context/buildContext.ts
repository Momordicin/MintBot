// services/core/context/buildContext.ts
import type { BuiltContext, ChatMessage } from '../../../shared/types/index.js'
import { requireCurrentState } from '../session/index.js'
import { getHistory } from '../session/index.js'

export async function buildContext(userInput: string): Promise<BuiltContext> {
  const { preset } = requireCurrentState()
  const history = getHistory(50)

  const messages: ChatMessage[] = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userInput },
  ]

  return {
    system: preset.systemPrompt,  // Phase 2：在这里拼入摘要、RAG召回、情绪状态等
    messages,
  }
}