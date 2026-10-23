import { describe, expect, it } from 'vitest'
import { INPUT_STRUCT_SIZE, toNativeInputs } from './sendInput'

describe('sendInput', () => {
  it.skipIf(process.platform !== 'win32' || process.arch !== 'x64')('uses the 40-byte INPUT layout SendInput requires on x64', () => {
    expect(INPUT_STRUCT_SIZE).toBe(40)
  })

  it('maps key inputs to keyboard INPUT records', () => {
    expect(toNativeInputs([{ vk: 0, scan: 0x4e2d, flags: 4 }])).toEqual([
      { type: 1, u: { ki: { wVk: 0, wScan: 0x4e2d, dwFlags: 4, time: 0, dwExtraInfo: 0 } } },
    ])
  })
})
