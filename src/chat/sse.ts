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
