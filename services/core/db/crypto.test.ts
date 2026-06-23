import { describe, it, expect } from 'vitest'
import { encrypt, decrypt } from './crypto.js'

describe('crypto', () => {
  it('加密后能正确解密', () => {
    const original = '测试内容 hello world'
    const encrypted = encrypt(original)
    expect(decrypt(encrypted)).toBe(original)
  })

  it('加密结果不等于原文', () => {
    const original = '敏感数据'
    expect(encrypt(original)).not.toBe(original)
  })

  it('相同内容两次加密结果不同（IV 随机）', () => {
    const original = '同样的内容'
    expect(encrypt(original)).not.toBe(encrypt(original))
  })

  it('空字符串可以加密解密', () => {
    expect(decrypt(encrypt(''))).toBe('')
  })
})