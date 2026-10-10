import { describe, it, expect } from 'vitest'
import {
  selectTransitionTrigger,
  shouldPlayFallAsleep,
  parseTransitionResponse,
  pickTransitionFiles,
  isTransitionLocked,
  resolveOverlayDisplayFile,
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

describe('transitionState: parseTransitionResponse（只做响应外形防御，不解释转场配置）', () => {
  it('返回核心服务给出的 steps 数组', () => {
    const steps = [{ files: ['a.gif'], durationMs: 1000 }]
    expect(parseTransitionResponse({ steps })).toEqual(steps)
  })

  it('响应缺 steps、steps 不是数组或响应为 null 时视为没有转场', () => {
    expect(parseTransitionResponse({})).toEqual([])
    expect(parseTransitionResponse({ steps: 'x' })).toEqual([])
    expect(parseTransitionResponse(null)).toEqual([])
  })

  it('丢弃畸形步骤：files 缺失/非数组/为空/含非字符串，durationMs 缺失/非数字/非有限/不大于 0，或步骤本身不是对象', () => {
    const good = { files: ['a.gif'], durationMs: 1000 }
    const malformed: unknown[] = [
      null,
      'x',
      7,
      {},
      { durationMs: 1000 },
      { files: 'a.gif', durationMs: 1000 },
      { files: [], durationMs: 1000 },
      { files: ['a.gif', 3], durationMs: 1000 },
      { files: ['a.gif'] },
      { files: ['a.gif'], durationMs: '1000' },
      { files: ['a.gif'], durationMs: Number.NaN },
      { files: ['a.gif'], durationMs: Number.POSITIVE_INFINITY },
      { files: ['a.gif'], durationMs: 0 },
      { files: ['a.gif'], durationMs: -5 },
    ]
    expect(parseTransitionResponse({ steps: [...malformed, good] })).toEqual([good])
    expect(parseTransitionResponse({ steps: malformed })).toEqual([])
  })
})

describe('transitionState: pickTransitionFiles 每步在候选并集里均匀随机挑一个', () => {
  it('每步挑出一个落在该步候选内的文件，保留 durationMs 与步骤顺序', () => {
    const steps = pickTransitionFiles([
      { files: ['a.gif', 'b.gif'], durationMs: 1000 },
      { files: ['c.gif'], durationMs: 2000 },
    ])
    expect(steps).toHaveLength(2)
    expect(['a.gif', 'b.gif']).toContain(steps[0].file)
    expect(steps[0].durationMs).toBe(1000)
    expect(steps[1]).toEqual({ file: 'c.gif', durationMs: 2000 })
  })

  it('通过注入的 pick 选择：随机函数拿到的是整个候选数组（对候选一视同仁）', () => {
    const seen: string[][] = []
    const steps = pickTransitionFiles([{ files: ['a.gif', 'b.gif', 'c.gif'], durationMs: 1 }], items => {
      seen.push(items as string[])
      return items[2]
    })
    expect(seen).toEqual([['a.gif', 'b.gif', 'c.gif']])
    expect(steps).toEqual([{ file: 'c.gif', durationMs: 1 }])
  })

  it('候选为空的步骤被丢弃，没有步骤时返回空数组（当作没有转场）', () => {
    expect(pickTransitionFiles([{ files: [], durationMs: 1000 }])).toEqual([])
    expect(pickTransitionFiles([])).toEqual([])
  })
})

describe('transitionState: isTransitionLocked（锁与转场生命周期绑定：非入睡转场从触发到结束都锁）', () => {
  it('没有转场在进行时未锁', () => {
    expect(isTransitionLocked(null)).toBe(false)
  })

  it('入睡转场不锁点击', () => {
    expect(isTransitionLocked('fall-asleep')).toBe(false)
  })

  it('其余触发器（含仍在拉取候选的阶段）都锁', () => {
    expect(isTransitionLocked('wake-from-sleep')).toBe(true)
    expect(isTransitionLocked('wake-from-bored')).toBe(true)
    expect(isTransitionLocked('poke-neutral')).toBe(true)
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
