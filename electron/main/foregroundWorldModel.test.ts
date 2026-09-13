import { describe, it, expect } from 'vitest'
import { selectValidationMode } from './foregroundWorldModel'
import { noteDragStart, isAnyDragInProgress, clearDragState } from './dragActivity'

// 只测本文件里不依赖真实 Win32/定时器状态的纯函数——runValidationPass 本身读
// getActiveWindowInfo()/isAnyDragInProgress()/模块级 displayStateMap，不在这里测，跟
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
})

// Fix 1 (second rework pass): runValidationPass feeds selectValidationMode's second argument with
// isAnyDragInProgress() — the one deliberately global signal that still spans both windows (see
// dragActivity.ts's header comment for why this one, unlike the pet's isInteracting and each
// window's move-skip guard, must NOT be split per-window). This composes the real
// isAnyDragInProgress() with the real selectValidationMode() to pin that a drag on either window
// alone is still enough to arm conservative mode.
describe('runValidationPass composition (Fix 1) — a single window\'s drag still arms conservative mode globally', () => {
  it('a chat-only drag puts selectValidationMode in conservative mode', () => {
    noteDragStart('chat', 0)
    expect(selectValidationMode(false, isAnyDragInProgress(0))).toBe('conservative')
    clearDragState('chat')
  })

  it('an overlay-only drag puts selectValidationMode in conservative mode', () => {
    noteDragStart('overlay', 0)
    expect(selectValidationMode(false, isAnyDragInProgress(0))).toBe('conservative')
    clearDragState('overlay')
  })

  it('neither window dragging is standard mode (baseline, not self-foreground)', () => {
    clearDragState('overlay')
    clearDragState('chat')
    expect(selectValidationMode(false, isAnyDragInProgress(0))).toBe('standard')
  })
})
