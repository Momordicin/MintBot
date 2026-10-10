import { describe, it, expect } from 'vitest'
import { selectValidationMode } from './foregroundWorldModel'
import { noteDragStart, isWindowDragInProgress, clearDragState } from './dragActivity'

// 只测本文件里不依赖真实 Win32/定时器状态的纯函数——runValidationPass 本身读
// getActiveWindowInfo()/isWindowDragInProgress('overlay')/模块级 displayStateMap，不在这里测，跟
// windowBehavior.test.ts「只测纯函数」同一个约定

describe('selectValidationMode (Fix 3 — conservative mode armed by the real cause, not just a drag)', () => {
  it('is conservative when MintBot itself is the foreground, even with no drag in progress', () => {
    expect(selectValidationMode(true, false)).toBe('conservative')
  })

  it('is conservative when a user drag is in progress, even when MintBot is not the foreground', () => {
    expect(selectValidationMode(false, true)).toBe('conservative')
  })

  it('is conservative when both conditions hold', () => {
    expect(selectValidationMode(true, true)).toBe('conservative')
  })

  it('is standard when neither condition holds', () => {
    expect(selectValidationMode(false, false)).toBe('standard')
  })

  it('is conservative when forced, even with no self foreground and no drag', () => {
    expect(selectValidationMode(false, false, true)).toBe('conservative')
  })

  it('stays standard when the force flag is explicitly false', () => {
    expect(selectValidationMode(false, false, false)).toBe('standard')
  })
})

describe('runValidationPass composition — only the overlay window drag arms conservative mode', () => {
  it('an overlay-only drag puts selectValidationMode in conservative mode', () => {
    noteDragStart('overlay', 0)
    expect(selectValidationMode(false, isWindowDragInProgress('overlay', 0))).toBe('conservative')
    clearDragState('overlay')
  })

  it('a chat-only drag leaves selectValidationMode in standard mode (chat is foreground then, covered by the self condition)', () => {
    noteDragStart('chat', 0)
    expect(selectValidationMode(false, isWindowDragInProgress('overlay', 0))).toBe('standard')
    clearDragState('chat')
  })
})
