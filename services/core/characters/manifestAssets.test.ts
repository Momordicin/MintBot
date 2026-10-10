// services/core/characters/manifestAssets.test.ts — 素材组校验与转场链解析的单元测试（注入文件存在检查 + 真实临时目录两种方式）
//
// 用法：pnpm test
// 配套文件：services/core/characters/manifestAssets.ts

import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  checkFileGroup,
  resolveTransitionChain,
  validateManifestAssets,
  isRegularFileOnDisk,
  type IsRegularFile,
} from './manifestAssets.js'

const DIR = path.join(os.tmpdir(), 'mintbot-fake-character')
const allExist: IsRegularFile = () => true

function chainOf(rawManifest: unknown, trigger = 'poke-neutral', form: 'pixel' | 'illustration' = 'pixel', isRegularFile: IsRegularFile = allExist) {
  return resolveTransitionChain({ characterId: 'c1', characterDir: DIR, rawManifest, trigger, form, isRegularFile })
}

describe('checkFileGroup', () => {
  it('合法扩展名（不区分大小写）且文件存在的条目全部保留', () => {
    const result = checkFileGroup(DIR, ['a.gif', 'b.PNG', 'c.jpg', 'd.JPEG', 'sub/e.webp'], allExist)
    expect(result.validFiles).toEqual(['a.gif', 'b.PNG', 'c.jpg', 'd.JPEG', 'sub/e.webp'])
    expect(result.problems).toEqual([])
  })

  it('扩展名不受支持的条目被单独忽略，其余保留', () => {
    const result = checkFileGroup(DIR, ['a.gif', 'b.mp4', 'noext'], allExist)
    expect(result.validFiles).toEqual(['a.gif'])
    expect(result.problems).toHaveLength(2)
    expect(result.problems[0].message).toContain('file=b.mp4')
  })

  it('文件不存在（注入检查返回 false）的条目被忽略并带上文件路径', () => {
    const result = checkFileGroup(DIR, ['a.gif', 'gone.gif'], absolutePath => !absolutePath.endsWith('gone.gif'))
    expect(result.validFiles).toEqual(['a.gif'])
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0].message).toContain('file=gone.gif')
  })

  it('路径越出角色包目录（../ 与绝对路径）的条目被拒绝，即使文件存在', () => {
    const absolute = path.join(DIR, 'inside.gif')
    const result = checkFileGroup(DIR, ['../evil.gif', 'sub/../../evil.png', absolute, 'ok.gif'], allExist)
    expect(result.validFiles).toEqual(['ok.gif'])
    expect(result.problems).toHaveLength(3)
    expect(result.problems.every(problem => problem.message.includes('越出'))).toBe(true)
  })

  it('非字符串条目被忽略，其余保留', () => {
    const result = checkFileGroup(DIR, ['a.gif', 42, null, { file: 'x.gif' }], allExist)
    expect(result.validFiles).toEqual(['a.gif'])
    expect(result.problems).toHaveLength(3)
  })

  it('素材组本身不是数组时返回空结果并告警', () => {
    const result = checkFileGroup(DIR, 'a.gif', allExist)
    expect(result.validFiles).toEqual([])
    expect(result.problems).toHaveLength(1)
  })

  describe('真实磁盘检查', () => {
    let tempDir: string | undefined
    afterEach(() => {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    })

    it('只认普通文件：存在的文件通过，目录与缺失文件不通过', () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mintbot-assets-'))
      fs.writeFileSync(path.join(tempDir, 'real.gif'), '')
      fs.mkdirSync(path.join(tempDir, 'dir.gif'))

      const result = checkFileGroup(tempDir, ['real.gif', 'dir.gif', 'missing.gif'])
      expect(result.validFiles).toEqual(['real.gif'])
      expect(result.problems).toHaveLength(2)
      expect(isRegularFileOnDisk(path.join(tempDir, 'real.gif'))).toBe(true)
    })
  })
})

describe('resolveTransitionChain', () => {
  const manifest = {
    portraits: {
      pixel: { emotions: { happy: ['h1.gif', 'h2.gif'], shy: ['s1.gif', 'h1.gif'], sad: ['x.mp4'] } },
      illustration: { emotions: { happy: ['ill.png'] } },
    },
    transitions: {
      'poke-neutral': [{ from: ['emotions.happy', 'emotions.shy'], durationMs: 2000 }],
    },
  }

  it('多个来源的有效文件取并集并去重，保留声明的 durationMs', () => {
    const { steps, problems } = chainOf(manifest)
    expect(steps).toEqual([{ files: ['h1.gif', 'h2.gif', 's1.gif'], durationMs: 2000 }])
    expect(problems).toEqual([])
  })

  it('from 为单个字符串时同样解析', () => {
    const { steps } = chainOf({ ...manifest, transitions: { t: [{ from: 'emotions.happy', durationMs: 500 }] } }, 't')
    expect(steps).toEqual([{ files: ['h1.gif', 'h2.gif'], durationMs: 500 }])
  })

  it('部分来源有问题时保留该步：坏键只被单独忽略并按键告警', () => {
    const raw = {
      ...manifest,
      transitions: {
        t: [{ from: ['emotions.happy', 'emotions.nope', 'reservedStates.x', 7, 'emotions.sad', 'emotions.'], durationMs: 1000 }],
      },
    }
    const { steps, problems } = chainOf(raw, 't')
    expect(steps).toEqual([{ files: ['h1.gif', 'h2.gif'], durationMs: 1000 }])
    const messages = problems.map(problem => problem.message)
    expect(messages.some(message => message.includes('trigger=t') && message.includes('step=0') && message.includes('key=emotions.nope'))).toBe(true)
    expect(messages.some(message => message.includes('key=reservedStates.x'))).toBe(true)
    expect(messages.some(message => message.includes('key=emotions.sad') && message.includes('file=x.mp4'))).toBe(true)
    expect(messages.every(message => message.includes('character=c1'))).toBe(true)
  })

  it('没有任何可用素材的步骤被跳过，其余步骤保留', () => {
    const raw = {
      ...manifest,
      transitions: { t: [{ from: 'emotions.sad', durationMs: 1000 }, { from: 'emotions.happy', durationMs: 1000 }] },
    }
    const { steps, problems } = chainOf(raw, 't')
    expect(steps).toEqual([{ files: ['h1.gif', 'h2.gif'], durationMs: 1000 }])
    expect(problems.some(problem => problem.message.includes('step=0') && problem.message.includes('没有可用素材'))).toBe(true)
  })

  it('durationMs 缺失/非数字/非正/非有限时使用 3000 并告警，不丢弃该步', () => {
    const bad = [undefined, '3000', 0, -5, Infinity, Number.NaN]
    for (const durationMs of bad) {
      const raw = { ...manifest, transitions: { t: [{ from: 'emotions.happy', durationMs }] } }
      const { steps, problems } = chainOf(raw, 't')
      expect(steps).toEqual([{ files: ['h1.gif', 'h2.gif'], durationMs: 3000 }])
      expect(problems.some(problem => problem.severity === 'warn' && problem.message.includes('durationMs'))).toBe(true)
    }
  })

  it('pick 缺省或为 random 不告警；其它值记 error 级问题并按 random 处理', () => {
    const run = (pick: unknown) => chainOf({ ...manifest, transitions: { t: [{ from: 'emotions.happy', durationMs: 1, pick }] } }, 't')
    expect(run(undefined).problems).toEqual([])
    expect(run('random').problems).toEqual([])
    const odd = run('first')
    expect(odd.steps).toHaveLength(1)
    expect(odd.problems).toEqual([expect.objectContaining({ severity: 'error' })])
    expect(odd.problems[0].message).toContain('pick="first"')
  })

  it('form 决定读取哪一组立绘', () => {
    const raw = { ...manifest, transitions: { t: [{ from: 'emotions.happy', durationMs: 1 }] } }
    expect(chainOf(raw, 't', 'pixel').steps[0].files).toEqual(['h1.gif', 'h2.gif'])
    expect(chainOf(raw, 't', 'illustration').steps[0].files).toEqual(['ill.png'])
  })

  it('不依赖 emotionVocabulary：未声明词表时照常解析', () => {
    const { steps } = chainOf({ ...manifest, emotionVocabulary: [] }, 'poke-neutral')
    expect(steps).toHaveLength(1)
  })

  it('触发器缺失、转场链不是数组、manifest 不是对象时返回空链；非数组链告警', () => {
    expect(chainOf(manifest, 'unknown')).toEqual({ steps: [], problems: [] })
    expect(chainOf(null).steps).toEqual([])
    const notArray = chainOf({ ...manifest, transitions: { t: { from: 'emotions.happy' } } }, 't')
    expect(notArray.steps).toEqual([])
    expect(notArray.problems).toHaveLength(1)
  })

  it('原型链上的键不会被当作素材组或转场链', () => {
    const raw = { ...manifest, transitions: { t: [{ from: ['emotions.constructor', 'emotions.__proto__'], durationMs: 1 }] } }
    expect(chainOf(raw, 't').steps).toEqual([])
    expect(chainOf(raw, 'toString').steps).toEqual([])
  })

  it('步骤不是对象或缺少 from 时只跳过该步', () => {
    const raw = { ...manifest, transitions: { t: ['x', { durationMs: 1 }, { from: 'emotions.happy', durationMs: 1 }] } }
    const { steps, problems } = chainOf(raw, 't')
    expect(steps).toHaveLength(1)
    expect(problems).toHaveLength(2)
  })

  it('文件检查结果按文件生效：缺失的文件不进入候选', () => {
    const { steps } = chainOf(manifest, 'poke-neutral', 'pixel', ((absolutePath: string) => !absolutePath.endsWith('h2.gif')))
    expect(steps[0].files).toEqual(['h1.gif', 's1.gif'])
  })
})

describe('validateManifestAssets', () => {
  it('覆盖两种立绘、互动状态、保留状态与转场，问题带角色 id 与位置', () => {
    const raw = {
      portraits: {
        pixel: { emotions: { idle: ['a.gif', 'bad.txt'] } },
        illustration: { emotions: { idle: ['b.png'] } },
      },
      interactionStates: { drag: 'c.gif', bad: 5 },
      reservedStates: { sleeping: ['d.gif'] },
      transitions: { t: [{ from: 'emotions.idle', durationMs: 1 }] },
    }
    const problems = validateManifestAssets('c1', raw, DIR, absolutePath => !absolutePath.endsWith('b.png'))
    const messages = problems.map(problem => problem.message)
    expect(messages.some(message => message.includes('portraits.pixel.emotions.idle') && message.includes('file=bad.txt'))).toBe(true)
    expect(messages.some(message => message.includes('portraits.illustration.emotions.idle') && message.includes('file=b.png'))).toBe(true)
    expect(messages.some(message => message.includes('interactionStates.bad'))).toBe(true)
    expect(messages.some(message => message.includes('trigger=t') && message.includes('file=bad.txt'))).toBe(true)
    expect(messages.every(message => message.includes('character=c1'))).toBe(true)
  })

  it('manifest 结构缺失或类型错误时不抛错、不产生问题', () => {
    expect(validateManifestAssets('c1', null, DIR, allExist)).toEqual([])
    expect(validateManifestAssets('c1', { portraits: 'x', interactionStates: [], transitions: 3 }, DIR, allExist)).toEqual([])
  })
})
