import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { getEncryptSensitiveFields } from '../config/security.js'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const TAG_LENGTH = 16

// 注意：切换 encryptSensitiveFields 开关不支持对已有数据重新加密/解密迁移（超出本次范围）。
// 某一模式下写入的数据必须以同一模式读回，中途切换会导致已写入数据无法正确解密/显示为密文。

function getKey(): Buffer {
  const key = process.env.DB_ENCRYPTION_KEY
  if (!key) throw new Error('[Crypto] DB_ENCRYPTION_KEY is not set')
  const buf = Buffer.from(key, 'hex')
  if (buf.length !== 32) throw new Error('[Crypto] DB_ENCRYPTION_KEY must be 32 bytes (64 hex chars)')
  return buf
}

export function encrypt(text: string): string {
  if (!getEncryptSensitiveFields()) return text
  const key = getKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

export function decrypt(data: string): string {
  if (!getEncryptSensitiveFields()) return data
  const key = getKey()
  const buf = Buffer.from(data, 'base64')
  const iv = buf.subarray(0, IV_LENGTH)
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}