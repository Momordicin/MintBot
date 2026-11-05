import { describe, expect, it } from 'vitest'
import { mergeAfterForget } from './mergeAfterForget'
import type { MessageData } from './MessageBubble'

function msg(id: string, role: MessageData['role'] = 'user'): MessageData {
  return { id, role, content: id, createdAt: 0 }
}

describe('mergeAfterForget', () => {
  it('replaces the list with the page when nothing is pending', () => {
    const page = [msg('7', 'assistant')]
    const current = [msg('1'), msg('2', 'assistant'), msg('local-1', 'system')]
    expect(mergeAfterForget(page, current, new Set())).toEqual(page)
  })

  it('appends pending local messages after the page', () => {
    const page = [msg('7', 'assistant')]
    const pending = msg('local-3')
    const current = [msg('1'), msg('2', 'assistant'), pending]
    expect(mergeAfterForget(page, current, new Set(['local-3']))).toEqual([...page, pending])
  })

  it('keeps pending messages in their original order when one sat in the middle of the list', () => {
    const first = msg('local-4')
    const second = msg('local-5')
    const current = [msg('1'), first, msg('2', 'assistant'), msg('local-6', 'system'), second]
    const merged = mergeAfterForget([msg('9')], current, new Set(['local-4', 'local-5']))
    expect(merged.map(m => m.id)).toEqual(['9', 'local-4', 'local-5'])
  })
})
