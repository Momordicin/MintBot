import { describe, it, expect } from 'vitest'
import { CORE_URL, resolveAssetUrl } from './coreUrl'

describe('resolveAssetUrl', () => {
  it('keeps "/" between path segments', () => {
    expect(resolveAssetUrl('mint', 'avatars/me.png')).toBe(`${CORE_URL}/characters/mint/avatars/me.png`)
  })

  it('encodes spaces and non-ASCII per segment', () => {
    expect(resolveAssetUrl('mint', 'my dir/头像 1.png')).toBe(
      `${CORE_URL}/characters/mint/my%20dir/${encodeURIComponent('头像 1.png')}`
    )
  })

  it('encodes the characterId', () => {
    expect(resolveAssetUrl('a b/c', 'x.png')).toBe(`${CORE_URL}/characters/a%20b%2Fc/x.png`)
  })

  it('percent-encodes "#" and "?" inside a segment', () => {
    expect(resolveAssetUrl('mint', 'a#b/c?d.png')).toBe(`${CORE_URL}/characters/mint/a%23b/c%3Fd.png`)
  })
})
