import { describe, it, expect } from 'vitest'
import {
  selectTransitionTrigger,
  shouldPlayFallAsleep,
  selectTransitionFile,
  resolveTransitionSteps,
  parseTransitionChain,
  resolveOverlayDisplayFile,
} from './transitionState.js'
import type { OverlayManifest } from './portraitState.js'
import type { TransitionChainStep } from '../../shared/transitionChain.js'

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

describe('transitionState: selectTransitionFile（pick 在候选集合里挑一个）', () => {
  const step: TransitionChainStep = { files: ['a.gif', 'b.gif', 'c.gif'], durationMs: 3000, pick: 'random' }

  it('random 把候选集合交给随机函数，返回它挑中的文件', () => {
    const seen: unknown[][] = []
    const file = selectTransitionFile(step, items => {
      seen.push(items)
      return items[2]
    })

    expect(file).toBe('c.gif')
    expect(seen).toEqual([['a.gif', 'b.gif', 'c.gif']])
  })

  it('random 默认实现多次挑选都落在候选集合内，且每个候选都有机会被挑中', () => {
    const picked = new Set<string>()
    for (let i = 0; i < 300; i++) picked.add(selectTransitionFile(step))

    expect([...picked].sort()).toEqual(['a.gif', 'b.gif', 'c.gif'])
  })

  it('只有一个候选时必定挑中它', () => {
    expect(selectTransitionFile({ files: ['only.gif'], durationMs: 1, pick: 'random' })).toBe('only.gif')
  })
})

describe('transitionState: resolveTransitionSteps', () => {
  it('每一步各挑一个文件，保留顺序与 durationMs', () => {
    const chain: TransitionChainStep[] = [
      { files: ['a.gif'], durationMs: 3000, pick: 'random' },
      { files: ['b.gif'], durationMs: 2000, pick: 'random' },
    ]

    expect(resolveTransitionSteps(chain)).toEqual([
      { file: 'a.gif', durationMs: 3000 },
      { file: 'b.gif', durationMs: 2000 },
    ])
  })

  it('空链得到零步骤', () => {
    expect(resolveTransitionSteps([])).toEqual([])
  })
})

describe('transitionState: parseTransitionChain（整份响应校验，任何一处不合格都得到空链）', () => {
  const good = { files: ['a.gif', 'b.gif'], durationMs: 3000, pick: 'random' }

  it('合法响应原样返回各步骤；零步骤也合法', () => {
    expect(parseTransitionChain({ steps: [good, { ...good, durationMs: 1 }] })).toEqual([good, { ...good, durationMs: 1 }])
    expect(parseTransitionChain({ steps: [] })).toEqual([])
  })

  it.each([
    ['null', null],
    ['非对象', 'x'],
    ['缺 steps', {}],
    ['steps 不是数组', { steps: {} }],
    ['步骤为 null', { steps: [null] }],
    ['files 不是数组', { steps: [{ ...good, files: 'a.gif' }] }],
    ['files 为空数组', { steps: [{ ...good, files: [] }] }],
    ['files 含非字符串', { steps: [{ ...good, files: ['a.gif', 1] }] }],
    ['files 含空字符串', { steps: [{ ...good, files: [''] }] }],
    ['durationMs 缺失', { steps: [{ files: ['a.gif'], pick: 'random' }] }],
    ['durationMs 为字符串', { steps: [{ ...good, durationMs: '3000' }] }],
    ['durationMs 为 0', { steps: [{ ...good, durationMs: 0 }] }],
    ['durationMs 为负数', { steps: [{ ...good, durationMs: -1 }] }],
    ['durationMs 为 NaN', { steps: [{ ...good, durationMs: NaN }] }],
    ['durationMs 为 Infinity', { steps: [{ ...good, durationMs: Infinity }] }],
    ['pick 超出允许范围', { steps: [{ ...good, pick: 'first' }] }],
    ['pick 缺失', { steps: [{ files: ['a.gif'], durationMs: 1 }] }],
    ['合法步骤后跟不合格步骤，整份作废', { steps: [good, { ...good, durationMs: 0 }] }],
  ])('%s → 空链', (_name, data) => {
    expect(parseTransitionChain(data)).toEqual([])
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
