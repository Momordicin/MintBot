import { describe, it, expect } from 'vitest'
import {
  BOREDOM_THRESHOLD_MS,
  SLEEP_THRESHOLD_MS,
  deriveY,
  nextThresholdInstant,
  computeOverlaySize,
  fallbackFirstFile,
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
      interactionStates: { drag: 'gifs/drag.gif' },
      reservedStates: {
        'boredom-idle': ['gifs/bored.gif'],
        sleeping: ['gifs/sleep.gif'],
      },
    },
    illustration: {
      fallback: 'idle',
      emotions: {
        idle: ['art/full1.png', 'art/full2.png'],
        happy: ['art/half.png'],
      },
      reservedStates: {
        sleeping: ['art/sleep.png'],
      },
    },
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
    expect(resolveDisplayFile(undefined, 'pixel', null, 'happy')).toBeNull()
  })

  it('全新 session（无历史消息）→ y 为空 → x 未定，取 fallback 组第一个文件，不随机', () => {
    const y = deriveY({ lastAttentionAt: null, explicitSleep: false, now: Date.now() })
    expect(y).toBeNull()
    for (let i = 0; i < 20; i++) {
      expect(resolveDisplayFile(manifest, 'pixel', y, undefined)).toBe('gifs/idle1.gif')
    }
  })

  it('y 为空时由 x 决定', () => {
    expect(resolveDisplayFile(manifest, 'pixel', null, 'happy')).toBe('gifs/happy.gif')
  })

  it('x 存在且情绪组有多个文件时仍在该组里随机挑选', () => {
    const seen = new Set<string | null>()
    for (let i = 0; i < 200; i++) seen.add(resolveDisplayFile(manifest, 'illustration', null, 'idle'))
    expect(seen).toEqual(new Set(['art/full1.png', 'art/full2.png']))
  })

  it('y = 无聊 时取该形态 reservedStates.boredom-idle，即使 x 另有素材也不看 x', () => {
    expect(resolveDisplayFile(manifest, 'pixel', 'boredom-idle', 'happy')).toBe('gifs/bored.gif')
  })

  it('y = 睡着 时取该形态 reservedStates.sleeping，不是 emotions', () => {
    expect(resolveDisplayFile(manifest, 'pixel', 'sleeping', 'happy')).toBe('gifs/sleep.gif')
  })

  it('按形态取素材：同一份 manifest 下立绘形态读 portraits.illustration', () => {
    expect(resolveDisplayFile(manifest, 'illustration', null, 'happy')).toBe('art/half.png')
    expect(resolveDisplayFile(manifest, 'illustration', 'sleeping', 'happy')).toBe('art/sleep.png')
  })

  it('x 没有对应情绪时取该形态 fallback 组第一个文件', () => {
    expect(resolveDisplayFile(manifest, 'pixel', null, 'confused')).toBe('gifs/idle1.gif')
    expect(resolveDisplayFile(manifest, 'illustration', null, 'confused')).toBe('art/full1.png')
  })

  it('y 在当前形态下没有对应状态时取该形态 fallback 组第一个文件，不借用 x 也不借用别的形态', () => {
    expect(resolveDisplayFile(manifest, 'illustration', 'boredom-idle', 'happy')).toBe('art/full1.png')
  })

  it('fallback 也没有素材时返回 null（空白）', () => {
    const empty: OverlayManifest = { portraits: { pixel: { fallback: 'idle', emotions: {} } } }
    expect(resolveDisplayFile(empty, 'pixel', null, 'happy')).toBeNull()
  })

  it('当前形态整个缺失时返回 null', () => {
    const pixelOnly: OverlayManifest = { portraits: { pixel: manifest.portraits!.pixel } }
    expect(resolveDisplayFile(pixelOnly, 'illustration', null, 'happy')).toBeNull()
  })
})

describe('portraitState: fallbackFirstFile', () => {
  it('返回 fallback 情绪组的第一个文件', () => {
    expect(fallbackFirstFile(manifest.portraits!.pixel)).toBe('gifs/idle1.gif')
  })

  it('形态缺失、fallback 组不存在或为空数组时返回 null', () => {
    expect(fallbackFirstFile(undefined)).toBeNull()
    expect(fallbackFirstFile({ fallback: 'idle', emotions: {} })).toBeNull()
    expect(fallbackFirstFile({ fallback: 'idle', emotions: { idle: [] } })).toBeNull()
  })
})

describe('portraitState: selectInteractionStateFile（interactionStates 取材，形状是单个字符串不是数组）', () => {
  it('声明了对应键时直接返回该字符串，不做随机挑选', () => {
    expect(selectInteractionStateFile(manifest, 'pixel', 'drag')).toBe('gifs/drag.gif')
  })

  it('当前形态没有声明该键时取该形态 fallback 组第一个文件，不借用别的形态', () => {
    expect(selectInteractionStateFile(manifest, 'pixel', 'move')).toBe('gifs/idle1.gif')
    expect(selectInteractionStateFile(manifest, 'illustration', 'drag')).toBe('art/full1.png')
  })

  it('manifest 未加载完成（undefined）或形态缺失时返回 null', () => {
    expect(selectInteractionStateFile(undefined, 'pixel', 'drag')).toBeNull()
    expect(selectInteractionStateFile({ portraits: {} }, 'pixel', 'drag')).toBeNull()
  })
})

describe('portraitState: computeOverlaySize 窗口尺寸规则（只缩小，不放大）', () => {
  it('像素：最长边超过 132 时等比缩小到最长边 132', () => {
    expect(computeOverlaySize('pixel', 264, 132)).toEqual({ width: 132, height: 66 })
    expect(computeOverlaySize('pixel', 100, 400)).toEqual({ width: 33, height: 132 })
  })

  it('像素：最长边不超过 132 时保持原尺寸，不放大', () => {
    expect(computeOverlaySize('pixel', 64, 64)).toEqual({ width: 64, height: 64 })
    expect(computeOverlaySize('pixel', 132, 100)).toEqual({ width: 132, height: 100 })
  })

  it('立绘：高度超过 500 时等比缩小到高度 500，不看宽度', () => {
    expect(computeOverlaySize('illustration', 1000, 1000)).toEqual({ width: 500, height: 500 })
    expect(computeOverlaySize('illustration', 600, 1500)).toEqual({ width: 200, height: 500 })
  })

  it('立绘：高度不超过 500 时保持原尺寸，即使宽度很大也不缩', () => {
    expect(computeOverlaySize('illustration', 800, 500)).toEqual({ width: 800, height: 500 })
    expect(computeOverlaySize('illustration', 300, 400)).toEqual({ width: 300, height: 400 })
  })
})
