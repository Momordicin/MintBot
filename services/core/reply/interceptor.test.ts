import { describe, it, expect } from 'vitest'
import { isEmptyReply } from './interceptor.js'

describe('interceptor: isEmptyReply', () => {
  it('空字符串命中', () => {
    expect(isEmptyReply('')).toBe(true)
  })

  it('只有空白字符（空格/换行/制表符）时命中——去掉首尾空白后为空', () => {
    expect(isEmptyReply('   ')).toBe(true)
    expect(isEmptyReply('\n\n')).toBe(true)
    expect(isEmptyReply('  \t \n ')).toBe(true)
  })

  it('有实际内容时不命中', () => {
    expect(isEmptyReply('你好')).toBe(false)
  })

  it('前后带空白但正文本身非空时不命中', () => {
    expect(isEmptyReply('  你好呀  ')).toBe(false)
  })
})
