import { describe, it, expect } from 'vitest'
import { selectStableDisplayKey, fallbackDisplayKey } from './displayIdentity'

describe('selectStableDisplayKey', () => {
  it('returns the DeviceID verbatim when present', () => {
    const deviceId = '\\\\?\\DISPLAY#GSM5BBF#5&1a2b3c&0&UID4352#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}'
    expect(selectStableDisplayKey(deviceId, 42)).toBe(deviceId)
  })

  it('falls back to id:<id> for null or an empty DeviceID', () => {
    expect(selectStableDisplayKey(null, 42)).toBe('id:42')
    expect(selectStableDisplayKey('', 42)).toBe('id:42')
  })
})

describe('fallbackDisplayKey', () => {
  it('formats the display id', () => {
    expect(fallbackDisplayKey(7)).toBe('id:7')
  })
})
