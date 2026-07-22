import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { encrypt, decrypt } from './crypto.js'

// encryptSensitiveFields 默认关闭（本地明文），这里显式开启以测试线上部署下的加密行为
describe('crypto（encryptSensitiveFields = true，线上部署模式）', () => {
  const prevFlag = process.env.ENCRYPT_SENSITIVE_FIELDS
  beforeEach(() => {
    process.env.ENCRYPT_SENSITIVE_FIELDS = 'true'
  })
  afterEach(() => {
    process.env.ENCRYPT_SENSITIVE_FIELDS = prevFlag
  })

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

// encryptSensitiveFields 关闭（默认，本地部署）：encrypt/decrypt 均为透传，无需 DB_ENCRYPTION_KEY
describe('crypto（encryptSensitiveFields = false，本地默认模式）', () => {
  const prevFlag = process.env.ENCRYPT_SENSITIVE_FIELDS
  beforeEach(() => {
    delete process.env.ENCRYPT_SENSITIVE_FIELDS
  })
  afterEach(() => {
    process.env.ENCRYPT_SENSITIVE_FIELDS = prevFlag
  })

  it('encrypt 原样返回明文', () => {
    const original = '本地明文内容'
    expect(encrypt(original)).toBe(original)
  })

  it('decrypt 原样返回输入', () => {
    const original = '本地明文内容'
    expect(decrypt(original)).toBe(original)
  })
})