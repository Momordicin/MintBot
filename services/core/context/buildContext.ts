import { BuiltContext } from "../../../shared/types/index.js"
import { getHistory } from "../memory/history.js"
import { requireCurrentState } from "../session/index.js"

export async function buildContext(userInput: string): Promise<BuiltContext> {
  const { preset } = requireCurrentState()
  const history = getHistory(50)
  
  return {
    system: preset.systemPrompt,   // Phase 2 在这里拼入摘要、RAG、情绪等
    messages: [
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: userInput },
    ],
  }
}