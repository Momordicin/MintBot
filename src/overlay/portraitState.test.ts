import { describe, it, expect } from 'vitest'
import {
  BOREDOM_THRESHOLD_MS,
  SLEEP_THRESHOLD_MS,
  deriveY,
  nextThresholdInstant,
  resolveDisplayFile,
  selectInteractionStateFile,
  type OverlayManifest,
} from './portraitState.js'

const manifest: OverlayManifest = {
  portraits: {
    pixel: {
      fallback: 'idle',
      emotions: {
        idle: ['gifs/idle1.gif', 'gifs/idle2.gif'],
        happy: ['gifs/happy.gif'],
      },
    },
  },
  reservedStates: {
    'boredom-idle': ['gifs/bored.gif'],
    sleeping: ['gifs/sleep.gif'],
  },
}

describe('portraitState: deriveY', () => {
  it('会话没有任何历史消息（lastAttentionAt 为 null）时 y 为空，不当作无穷久以前', () => {
    expect(deriveY({ lastAttentionAt: null, explicitSleep: false, now: Date.now() })).toBeNull()
  })

  it('距上次搭理 < 15 分钟时 y 为空', () => {
    const now = 1_000_000
    expect(deriveY({ lastAttentionAt: now - (BOREDOM_THRESHOLD_MS - 1), explicitSleep: false, now })).toBeNull()
  })

  it('距上次搭理恰好 15 分钟时 y = 无聊（边界含）', () => {
    const now = 1_000_000
    expect(deriveY({ lastAttentionAt: now - BOREDOM_THRESHOLD_MS, explicitSleep: false, now })).toBe('boredom-idle')
  })

  it('距上次搭理 15-60 分钟之间 y = 无聊', () => {
    const now = 1_000_000
    expect(deriveY({ lastAttentionAt: now - (BOREDOM_THRESHOLD_MS + 1), explicitSleep: false, now })).toBe('boredom-idle')
  })

  it('距上次搭理恰好 60 分钟时 y = 睡着（边界含）', () => {
    const now = 1_000_000
    expect(deriveY({ lastAttentionAt: now - SLEEP_THRESHOLD_MS, explicitSleep: false, now })).toBe('sleeping')
  })

  it('距上次搭理 >= 60 分钟时 y = 睡着', () => {
    const now = 1_000_000
    expect(deriveY({ lastAttentionAt: now - (SLEEP_THRESHOLD_MS + 1), explicitSleep: false, now })).toBe('sleeping')
  })

  it('显式睡着标记优先于时长阈值——即使时长本应判定为空', () => {
    const now = 1_000_000
    expect(deriveY({ lastAttentionAt: now, explicitSleep: true, now })).toBe('sleeping')
  })

  it('显式睡着标记优先于时长阈值——即使时长本应判定为无聊', () => {
    const now = 1_000_000
    expect(deriveY({ lastAttentionAt: now - (BOREDOM_THRESHOLD_MS + 1), explicitSleep: true, now })).toBe('sleeping')
  })
})

describe('portraitState: nextThresholdInstant', () => {
  it('无历史消息（lastAttentionAt 为 null）时不调度', () => {
    expect(nextThresholdInstant(null, Date.now())).toBeNull()
  })

  it('< 15 分钟时下一阈值绝对时刻为 lastAttentionAt + 15 分钟', () => {
    const lastAttentionAt = 1_000_000
    const now = lastAttentionAt + 1000
    expect(nextThresholdInstant(lastAttentionAt, now)).toBe(lastAttentionAt + BOREDOM_THRESHOLD_MS)
  })

  it('恰好 15 分钟时（已跨入无聊档）下一阈值绝对时刻为 lastAttentionAt + 60 分钟', () => {
    const lastAttentionAt = 1_000_000
    const now = lastAttentionAt + BOREDOM_THRESHOLD_MS
    expect(nextThresholdInstant(lastAttentionAt, now)).toBe(lastAttentionAt + SLEEP_THRESHOLD_MS)
  })

  it('15-60 分钟之间时下一阈值绝对时刻为 lastAttentionAt + 60 分钟', () => {
    const lastAttentionAt = 1_000_000
    const now = lastAttentionAt + BOREDOM_THRESHOLD_MS + 1000
    expect(nextThresholdInstant(lastAttentionAt, now)).toBe(lastAttentionAt + SLEEP_THRESHOLD_MS)
  })

  it('>= 60 分钟时没有下一阈值', () => {
    const lastAttentionAt = 1_000_000
    const now = lastAttentionAt + SLEEP_THRESHOLD_MS
    expect(nextThresholdInstant(lastAttentionAt, now)).toBeNull()
  })
})

describe('portraitState: resolveDisplayFile 素材回落链', () => {
  it('manifest 未加载完成（undefined）时返回 null', () => {
    expect(resolveDisplayFile(undefined, null, 'happy')).toBeNull()
  })

  it('全新 session（无历史消息）→ y 为空 → 展示随机 idle 变体', () => {
    const y = deriveY({ lastAttentionAt: null, explicitSleep: false, now: Date.now() })
    expect(y).toBeNull()
    const file = resolveDisplayFile(manifest, y, undefined)
    expect(['gifs/idle1.gif', 'gifs/idle2.gif']).toContain(file)
  })

  it('y 为空时由 x 决定', () => {
    expect(resolveDisplayFile(manifest, null, 'happy')).toBe('gifs/happy.gif')
  })

  it('y = 无聊 时取 reservedStates.boredom-idle，即使 x 另有素材也不看 x', () => {
    expect(resolveDisplayFile(manifest, 'boredom-idle', 'happy')).toBe('gifs/bored.gif')
  })

  it('y = 睡着 时取 reservedStates.sleeping，不是 portraits.pixel.emotions（TDD「emotions 里没有 sleep」）', () => {
    expect(resolveDisplayFile(manifest, 'sleeping', 'happy')).toBe('gifs/sleep.gif')
  })

  it('y 没有对应素材时落到 x', () => {
    const noBoredom: OverlayManifest = { portraits: manifest.portraits }
    expect(resolveDisplayFile(noBoredom, 'boredom-idle', 'happy')).toBe('gifs/happy.gif')
  })

  it('x 没有对应素材时落到该形态声明的 fallback 标签', () => {
    const file = resolveDisplayFile(manifest, null, 'confused')
    expect(['gifs/idle1.gif', 'gifs/idle2.gif']).toContain(file)
  })

  it('x 为 undefined（全新 session 无情绪记录）时落到 fallback 标签', () => {
    const file = resolveDisplayFile(manifest, null, undefined)
    expect(['gifs/idle1.gif', 'gifs/idle2.gif']).toContain(file)
  })

  it('fallback 也没有素材时返回 null（空白）', () => {
    const empty: OverlayManifest = { portraits: { pixel: { fallback: 'idle', emotions: {} } } }
    expect(resolveDisplayFile(empty, null, 'happy')).toBeNull()
  })

  it('y = 睡着 但没有对应素材时落到 x，而不是空白', () => {
    const noSleep: OverlayManifest = {
      portraits: { pixel: { fallback: 'idle', emotions: { happy: ['gifs/happy.gif'] } } },
    }
    expect(resolveDisplayFile(noSleep, 'sleeping', 'happy')).toBe('gifs/happy.gif')
  })
})

describe('portraitState: selectInteractionStateFile（interactionStates 取材，形状是单个字符串不是数组）', () => {
  it('声明了对应键时直接返回该字符串，不做随机挑选', () => {
    const withDrag: OverlayManifest = { ...manifest, interactionStates: { drag: 'gifs/drag.gif' } }
    expect(selectInteractionStateFile(withDrag, 'drag')).toBe('gifs/drag.gif')
  })

  it('manifest 未声明 interactionStates 时返回 null', () => {
    expect(selectInteractionStateFile(manifest, 'drag')).toBeNull()
  })

  it('interactionStates 里没有该键时返回 null', () => {
    const withMove: OverlayManifest = { ...manifest, interactionStates: { move: 'gifs/move.gif' } }
    expect(selectInteractionStateFile(withMove, 'drag')).toBeNull()
  })

  it('manifest 未加载完成（undefined）时返回 null', () => {
    expect(selectInteractionStateFile(undefined, 'drag')).toBeNull()
  })
})
