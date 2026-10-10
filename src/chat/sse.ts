// src/chat/sse.ts — 把 fetch 返回的 SSE 响应流解析为事件序列
// 用法：for await (const { event, data } of parseSSE(response))；ChatWindow 用它读取 POST /chat 的响应
// 形状：parseSSE(response: Response) -> AsyncGenerator<{ event: string; data: unknown }>
// 对应文件：src/chat/ChatWindow.tsx / services/core/routes/chat.ts
export interface SSEEvent {
  event: string
  data: unknown
}

export async function* parseSSE(
  response: Response
): AsyncGenerator<SSEEvent> {
  if (!response.body) throw new Error('No response body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const chunks = buffer.split('\n\n')
    buffer = chunks.pop() ?? ''

    for (const chunk of chunks) {
      const lines = chunk.split('\n')
      let event = 'message'
      let dataStr = ''

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          event = line.slice(7).trim()
        } else if (line.startsWith('data: ')) {
          dataStr = line.slice(6).trim()
        }
      }

      if (!dataStr) continue

      try {
        yield { event, data: JSON.parse(dataStr) }
      } catch {
        yield { event, data: dataStr }
      }
    }
  }
}
