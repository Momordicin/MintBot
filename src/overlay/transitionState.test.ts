import { describe, it, expect } from 'vitest'
import {
  selectTransitionTrigger,
  shouldPlayFallAsleep,
  resolveTransitionChain,
  transitionEndInstant,
  isTransitionLocked,
  resolveOverlayDisplayFile,
  type ResolvedTransitionStep,
} from './transitionState.js'
import type { OverlayManifest } from './portraitState.js'

const manifest: OverlayManifest = {
  portraits: {
    pixel: {
      fallback: 'idle',
      emotions: {
        idle: ['gifs/idle1.gif'],
        happy: ['gifs/happy.gif'],
        confused: ['gifs/confused1.gif', 'gifs/confused2.gif'],
        shy: [],
      },
    },
  },
  transitions: {
    'fall-asleep': [
      { from: 'emotions.idle', pick: 'random', durationMs: 3000 },
    ],
    'wake-from-sleep': [
      { from: 'emotions.confused', pick: 'random', durationMs: 3000 },
      { from: 'emotions.happy', pick: 'random', durationMs: 3000 },
    ],
    'wake-from-bored': [
      { from: 'emotions.shy', pick: 'random', durationMs: 3000 },
    ],
    'poke-neutral': [
      { from: ['emotions.happy', 'emotions.confused'], pick: 'random', durationMs: 3000 },
    ],
  },
}

describe('transitionState: selectTransitionTrigger', () => {
  it('唤醒前 y = 睡着 → wake-from-sleep', () => {
    expect(selectTransitionTrigger('sleeping')).toBe('wake-from-sleep')
  })

  it('唤醒前 y = 无聊 → wake-from-bored', () => {
    expect(selectTransitionTrigger('boredom-idle')).toBe('wake-from-bored')
  })

  it('唤醒前 y = 空 → poke-neutral（本批次无调用入口，但映射本身要能算对）', () => {
    expect(selectTransitionTrigger(null)).toBe('poke-neutral')
  })
})

describe('transitionState: shouldPlayFallAsleep（TDD「入睡转场」表格：只有运行期阈值定时器造成的迁移才播）', () => {
  it('阈值定时器触发 + y 从空迁移到睡着 → 播', () => {
    expect(shouldPlayFallAsleep({ explicitSleep: false, calledByThresholdTimer: true, previousY: null, nextY: 'sleeping' })).toBe(true)
  })

  it('阈值定时器触发 + y 从无聊迁移到睡着 → 播', () => {
    expect(shouldPlayFallAsleep({ explicitSleep: false, calledByThresholdTimer: true, previousY: 'boredom-idle', nextY: 'sleeping' })).toBe(true)
  })

  it('非阈值定时器触发（挂载/preset-switched/转场结束）即使算出睡着也不播——载入是取快照，不是真实迁移', () => {
    expect(shouldPlayFallAsleep({ explicitSleep: false, calledByThresholdTimer: false, previousY: null, nextY: 'sleeping' })).toBe(false)
  })

  it('阈值定时器触发但迁移前已经是睡着 → 不重播（避免转场结束后的重新求值把自己又触发一遍）', () => {
    expect(shouldPlayFallAsleep({ explicitSleep: false, calledByThresholdTimer: true, previousY: 'sleeping', nextY: 'sleeping' })).toBe(false)
  })

  it('阈值定时器触发但这次没有迁移到睡着（只是到了无聊档）→ 不播', () => {
    expect(shouldPlayFallAsleep({ explicitSleep: false, calledByThresholdTimer: true, previousY: null, nextY: 'boredom-idle' })).toBe(false)
  })
})

describe('transitionState: resolveTransitionChain 防御性解析', () => {
  it('manifest 未加载完成（undefined）时返回空数组', () => {
    expect(resolveTransitionChain(undefined, 'wake-from-sleep')).toEqual([])
  })

  it('角色包未声明 transitions 时返回空数组（TDD「回落规则」不播转场）', () => {
    const noTransitions: OverlayManifest = { portraits: manifest.portraits }
    expect(resolveTransitionChain(noTransitions, 'wake-from-sleep')).toEqual([])
  })

  it('正常两步链条：每步都解析出素材，且保留声明的 durationMs', () => {
    const steps = resolveTransitionChain(manifest, 'wake-from-sleep')
    expect(steps).toHaveLength(2)
    expect(['gifs/confused1.gif', 'gifs/confused2.gif']).toContain(steps[0].file)
    expect(steps[0].durationMs).toBe(3000)
    expect(steps[1]).toEqual({ file: 'gifs/happy.gif', durationMs: 3000 })
  })

  it('fall-asleep 与唤醒三条转场走同一套解析机制，不需要特殊处理（TDD「名字不编码来源」）', () => {
    expect(resolveTransitionChain(manifest, 'fall-asleep')).toEqual([
      { file: 'gifs/idle1.gif', durationMs: 3000 },
    ])
  })

  it('from 为数组时能在多个来源间解析出素材（TDD「from 可以是数组（先在多个来源间随机挑一个）」）', () => {
    const steps = resolveTransitionChain(manifest, 'poke-neutral')
    expect(steps).toHaveLength(1)
    // 数组两个来源（happy/confused）都非空——无论随机挑中哪一个，结果都必须落在两者
    // 候选素材的并集内，不会因为"多个来源"这件事本身导致解析失败
    expect(['gifs/happy.gif', 'gifs/confused1.gif', 'gifs/confused2.gif']).toContain(steps[0].file)
  })

  it('durationMs 缺失/非正/非有限数时整步跳过', () => {
    const badManifest: OverlayManifest = {
      portraits: manifest.portraits,
      transitions: {
        'wake-from-bored': [
          { from: 'emotions.happy', durationMs: 0 },
          { from: 'emotions.happy', durationMs: -100 },
          { from: 'emotions.happy', durationMs: Infinity },
          { from: 'emotions.happy', durationMs: Number.NaN },
          { from: 'emotions.happy' },
          { from: 'emotions.happy', durationMs: '3000' },
        ],
      },
    }
    expect(resolveTransitionChain(badManifest, 'wake-from-bored')).toEqual([])
  })

  it('from 条目不是 "emotions.<key>" 形式时被过滤，整步因无可用来源而跳过', () => {
    const badManifest: OverlayManifest = {
      portraits: manifest.portraits,
      transitions: {
        'wake-from-bored': [
          { from: 'happy', durationMs: 3000 },
          { from: 'reservedStates.thinking', durationMs: 3000 },
          { from: 'interactionStates.drag', durationMs: 3000 },
        ],
      },
    }
    expect(resolveTransitionChain(badManifest, 'wake-from-bored')).toEqual([])
  })

  it('from 数组里混有非法条目时，只保留合法的 emotions.<key> 部分', () => {
    const mixedManifest: OverlayManifest = {
      portraits: manifest.portraits,
      transitions: {
        'wake-from-bored': [
          { from: ['reservedStates.thinking', 'emotions.happy'], durationMs: 3000 },
        ],
      },
    }
    expect(resolveTransitionChain(mixedManifest, 'wake-from-bored')).toEqual([
      { file: 'gifs/happy.gif', durationMs: 3000 },
    ])
  })

  it('某一步引用的键没有对应素材（空数组）时该步跳过，不影响其余步骤', () => {
    const partialManifest: OverlayManifest = {
      portraits: manifest.portraits,
      transitions: {
        'wake-from-sleep': [
          { from: 'emotions.shy', durationMs: 1000 }, // shy 是空数组，解析不出
          { from: 'emotions.happy', durationMs: 2000 },
        ],
      },
    }
    expect(resolveTransitionChain(partialManifest, 'wake-from-sleep')).toEqual([
      { file: 'gifs/happy.gif', durationMs: 2000 },
    ])
  })

  it('某一步引用的键在 emotions 里完全不存在时该步跳过', () => {
    const missingKeyManifest: OverlayManifest = {
      portraits: manifest.portraits,
      transitions: {
        'wake-from-sleep': [
          { from: 'emotions.playful', durationMs: 1000 }, // playful 未声明
          { from: 'emotions.happy', durationMs: 2000 },
        ],
      },
    }
    expect(resolveTransitionChain(missingKeyManifest, 'wake-from-sleep')).toEqual([
      { file: 'gifs/happy.gif', durationMs: 2000 },
    ])
  })

  it('全部步骤都解析不出素材时返回空数组（当作没有转场，绝不卡住立绘）', () => {
    const allBadManifest: OverlayManifest = {
      portraits: manifest.portraits,
      transitions: {
        'wake-from-sleep': [
          { from: 'emotions.shy', durationMs: 1000 },
          { from: 'emotions.playful', durationMs: 2000 },
        ],
      },
    }
    expect(resolveTransitionChain(allBadManifest, 'wake-from-sleep')).toEqual([])
  })
})

describe('transitionState: transitionEndInstant', () => {
  it('结束时刻 = 开始时刻 + 全部步骤时长之和', () => {
    const steps: ResolvedTransitionStep[] = [
      { file: 'a.gif', durationMs: 3000 },
      { file: 'b.gif', durationMs: 2000 },
    ]
    expect(transitionEndInstant(steps, 1_000_000)).toBe(1_000_000 + 5000)
  })

  it('空步骤数组时结束时刻等于开始时刻', () => {
    expect(transitionEndInstant([], 1_000_000)).toBe(1_000_000)
  })
})

describe('transitionState: isTransitionLocked', () => {
  it('lockedUntil 为 null 时视为未锁', () => {
    expect(isTransitionLocked(null, Date.now())).toBe(false)
  })

  it('now 早于 lockedUntil 时仍锁着', () => {
    expect(isTransitionLocked(2000, 1000)).toBe(true)
  })

  it('now 达到 lockedUntil（边界）时已解锁——绝对结束时刻本身不算锁着', () => {
    expect(isTransitionLocked(2000, 2000)).toBe(false)
  })

  it('now 晚于 lockedUntil 时已解锁', () => {
    expect(isTransitionLocked(2000, 3000)).toBe(false)
  })
})

describe('transitionState: resolveOverlayDisplayFile 展示优先级', () => {
  it('转场播放中时，转场文件优先于 y/x（即使 y/x 另有对应素材）', () => {
    expect(resolveOverlayDisplayFile(manifest, 'gifs/confused1.gif', false, 'sleeping', 'happy')).toBe('gifs/confused1.gif')
  })

  it('没有转场在播放（null）时落回既有的 y/x 回落链', () => {
    expect(resolveOverlayDisplayFile(manifest, null, false, null, 'happy')).toBe('gifs/happy.gif')
  })

  it('转场播放中时，转场文件优先于拖拽（拖拽同时进行也不例外）', () => {
    const withDrag: OverlayManifest = { ...manifest, interactionStates: { drag: 'gifs/drag.gif' } }
    expect(resolveOverlayDisplayFile(withDrag, 'gifs/confused1.gif', true, 'sleeping', 'happy')).toBe('gifs/confused1.gif')
  })

  it('没有转场在播放但正在拖拽时，拖拽素材优先于 y/x', () => {
    const withDrag: OverlayManifest = { ...manifest, interactionStates: { drag: 'gifs/drag.gif' } }
    expect(resolveOverlayDisplayFile(withDrag, null, true, 'sleeping', 'happy')).toBe('gifs/drag.gif')
  })

  it('正在拖拽但角色包未声明 drag 素材时，落回既有的 y/x 回落链，不当作空白', () => {
    // manifest 没有 interactionStates.drag，selectInteractionStateFile 返回 null，
    // 继续落到 y/x 回落链——此处 y 为空，落到 x
    expect(resolveOverlayDisplayFile(manifest, null, true, null, 'happy')).toBe('gifs/happy.gif')
  })

  it('未在拖拽时（isDragging = false）即使角色包声明了 drag 素材也不使用', () => {
    const withDrag: OverlayManifest = { ...manifest, interactionStates: { drag: 'gifs/drag.gif' } }
    expect(resolveOverlayDisplayFile(withDrag, null, false, null, 'happy')).toBe('gifs/happy.gif')
  })
})

describe('transitionState: from 数组先筛可用来源再随机', () => {
  it('from 数组里混有无素材的来源时，该步必定仍能解析出素材，不会因为抽中空来源而整步消失', () => {
    const mixedManifest: OverlayManifest = {
      ...manifest,
      transitions: {
        'wake-from-bored': [
          { from: ['emotions.shy', 'emotions.happy'], pick: 'random', durationMs: 3000 },
        ],
      },
    }

    // emotions.shy 声明了但素材为空数组。随机只应在"确实有素材"的来源之间进行，
    // 否则这一步能不能播就成了掷硬币——链条只有一步时整条转场都会静默消失。
    // 多跑若干次覆盖随机性：每次都必须落在 happy 上，且永远不会解析成空链
    for (let i = 0; i < 50; i++) {
      expect(resolveTransitionChain(mixedManifest, 'wake-from-bored')).toEqual([
        { file: 'gifs/happy.gif', durationMs: 3000 },
      ])
    }
  })

  it('from 数组里全部来源都没有素材时，仍然判定该步解析不出', () => {
    const emptyManifest: OverlayManifest = {
      ...manifest,
      transitions: {
        'wake-from-bored': [
          { from: ['emotions.shy', 'emotions.nonexistent'], pick: 'random', durationMs: 3000 },
        ],
      },
    }

    expect(resolveTransitionChain(emptyManifest, 'wake-from-bored')).toEqual([])
  })
})

describe('transitionState: shouldPlayFallAsleep 只认时长档造成的入睡', () => {
  // TDD「入睡转场 fall-asleep」表格第二行：文本检测到困意时本轮播不了，表现为「下次看到它
  // 时已经睡着了」。显式睡着标记会一直挂到下一次 recordAttention 才清，所以任意一次后续的
  // 阈值定时器轮询都会「发现」它——若不看 explicitSleep，本该静默到来的入睡会被播成动画
  it('文本检测置上的显式睡着标记被阈值定时器发现时不播', () => {
    expect(shouldPlayFallAsleep({
      calledByThresholdTimer: true,
      previousY: null,
      nextY: 'sleeping',
      explicitSleep: true,
    })).toBe(false)
  })

  it('从无聊档被标记推进到睡着时同样不播', () => {
    expect(shouldPlayFallAsleep({
      calledByThresholdTimer: true,
      previousY: 'boredom-idle',
      nextY: 'sleeping',
      explicitSleep: true,
    })).toBe(false)
  })

  it('没有标记、由 60 分钟时长档迁移到睡着时照常播', () => {
    expect(shouldPlayFallAsleep({
      calledByThresholdTimer: true,
      previousY: 'boredom-idle',
      nextY: 'sleeping',
      explicitSleep: false,
    })).toBe(true)
  })
})
