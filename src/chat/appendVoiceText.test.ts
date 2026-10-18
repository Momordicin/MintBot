import { describe, expect, it } from 'vitest'
import { appendVoiceText } from './appendVoiceText'

describe('appendVoiceText', () => {
  it('joins Chinese text directly', () => {
    expect(appendVoiceText('你好', ['世界'])).toBe('你好世界')
  })

  it('inserts a space between ASCII non-whitespace characters', () => {
    expect(appendVoiceText('hello', ['world'])).toBe('hello world')
  })

  it('does not insert a space at a Chinese and English boundary', () => {
    expect(appendVoiceText('你好', ['world'])).toBe('你好world')
    expect(appendVoiceText('hello', ['世界'])).toBe('hello世界')
  })

  it('does not insert a space after existing whitespace', () => {
    expect(appendVoiceText('hello ', ['world'])).toBe('hello world')
    expect(appendVoiceText('hello\n', ['world'])).toBe('hello\nworld')
  })

  it('uses the texts as is when current is empty', () => {
    expect(appendVoiceText('', ['hello'])).toBe('hello')
  })

  it('applies the rule at every boundary for multiple texts', () => {
    expect(appendVoiceText('a', ['b', '你好', 'c', 'd'])).toBe('a b你好c d')
  })

  it('returns current when there are no texts', () => {
    expect(appendVoiceText('abc', [])).toBe('abc')
  })
})
