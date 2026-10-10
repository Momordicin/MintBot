// services/core/characters/transitionChain.test.ts — checkFileGroup 与 resolveTransitionChain 的 vitest 测试（临时目录里造素材）
//
// 用法：pnpm test
// 配套文件：services/core/characters/transitionChain.ts

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { checkFileGroup, resolveTransitionChain } from './transitionChain.js'

let characterDir: string
let outsideFile: string
let warnSpy: ReturnType<typeof vi.spyOn>

function touch(relativePath: string) {
  const full = path.join(characterDir, relativePath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, '')
}

function warnings(): string[] {
  return warnSpy.mock.calls.map((call: unknown[]) => String(call[0]))
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mintbot-transition-'))
  characterDir = path.join(root, 'hero')
  fs.mkdirSync(characterDir)
  outsideFile = path.join(root, 'outside.gif')
  fs.writeFileSync(outsideFile, '')
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  fs.rmSync(path.dirname(characterDir), { recursive: true, force: true })
  warnSpy.mockRestore()
})

describe('checkFileGroup', () => {
  it('只保留目录内真实存在、扩展名合法的文件，扩展名不区分大小写', () => {
    for (const file of ['a.gif', 'b.PNG', 'c.jpg', 'd.jpeg', 'e.WebP', 'sub/f.gif']) touch(file)

    const valid = checkFileGroup(characterDir, ['a.gif', 'b.PNG', 'c.jpg', 'd.jpeg', 'e.WebP', 'sub/f.gif'], 'ctx')

    expect(valid).toEqual(['a.gif', 'b.PNG', 'c.jpg', 'd.jpeg', 'e.WebP', 'sub/f.gif'])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('扩展名不合法的文件被跳过并记日志', () => {
    touch('a.txt')
    touch('noext')

    expect(checkFileGroup(characterDir, ['a.txt', 'noext'], 'ctx-ext')).toEqual([])
    expect(warnings().filter(m => m.includes('ctx-ext') && m.includes('a.txt'))).toHaveLength(1)
    expect(warnings().filter(m => m.includes('ctx-ext') && m.includes('noext'))).toHaveLength(1)
  })

  it('磁盘上不存在的文件和目录被跳过并记日志', () => {
    fs.mkdirSync(path.join(characterDir, 'dir.gif'))

    expect(checkFileGroup(characterDir, ['missing.gif', 'dir.gif'], 'ctx-missing')).toEqual([])
    expect(warnings().filter(m => m.includes('ctx-missing'))).toHaveLength(2)
  })

  it('绝对路径与越出目录的路径被跳过，即使目标文件真实存在', () => {
    const group = [outsideFile, '../outside.gif', 'sub/../../outside.gif', '/etc/x.gif', 'C:\\x.gif']

    expect(checkFileGroup(characterDir, group, 'ctx-escape')).toEqual([])
    expect(warnings().filter(m => m.includes('ctx-escape'))).toHaveLength(5)
  })

  it('先下钻再回退但仍在目录内的路径合法', () => {
    touch('a.gif')
    fs.mkdirSync(path.join(characterDir, 'sub'))

    expect(checkFileGroup(characterDir, ['sub/../a.gif'], 'ctx')).toEqual(['sub/../a.gif'])
  })

  it('非字符串项和空字符串被跳过，同组其他文件不受影响', () => {
    touch('ok.gif')

    expect(checkFileGroup(characterDir, [1, null, {}, '', 'ok.gif'], 'ctx-type')).toEqual(['ok.gif'])
    expect(warnings().filter(m => m.includes('ctx-type'))).toHaveLength(4)
  })

  it('整组不是数组时返回空并记日志', () => {
    expect(checkFileGroup(characterDir, 'a.gif', 'ctx-group')).toEqual([])
    expect(warnings().some(m => m.includes('ctx-group'))).toBe(true)
  })
})

describe('resolveTransitionChain', () => {
  function resolve(raw: unknown, trigger = 'poke-neutral', form: 'pixel' | 'illustration' = 'pixel') {
    return resolveTransitionChain({ characterId: 'hero', characterDir, raw, trigger, form })
  }

  it('同一步多个键的合法文件合并并去重，保持首次出现的顺序', () => {
    for (const file of ['a.gif', 'b.gif', 'c.gif']) touch(file)

    const chain = resolve({
      portraits: { pixel: { emotions: { happy: ['a.gif', 'b.gif'], shy: ['b.gif', 'c.gif'] } } },
      transitions: { 'poke-neutral': [{ from: ['emotions.happy', 'emotions.shy'], durationMs: 2000, pick: 'random' }] },
    })

    expect(chain).toEqual([{ files: ['a.gif', 'b.gif', 'c.gif'], durationMs: 2000, pick: 'random' }])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('from 为单个字符串时按单键处理', () => {
    touch('a.gif')

    const chain = resolve({
      portraits: { pixel: { emotions: { happy: ['a.gif'] } } },
      transitions: { 'poke-neutral': [{ from: 'emotions.happy', durationMs: 1000 }] },
    })

    expect(chain[0].files).toEqual(['a.gif'])
  })

  it('单个坏键不影响同一步里的其他键，并记日志写明角色、触发点、步序号、键', () => {
    touch('a.gif')

    const chain = resolve({
      portraits: { pixel: { emotions: { happy: ['a.gif'], broken: ['missing.gif'] } } },
      transitions: {
        'poke-neutral': [{ from: ['happy', 'emotions.nowhere', 7, 'emotions.broken', 'emotions.happy'], durationMs: 1000 }],
      },
    })

    expect(chain).toEqual([{ files: ['a.gif'], durationMs: 1000, pick: 'random' }])
    const messages = warnings().filter(m => m.includes('角色 hero') && m.includes('触发点 poke-neutral') && m.includes('第 1 步'))
    expect(messages.some(m => m.includes('"happy"'))).toBe(true)
    expect(messages.some(m => m.includes('emotions.nowhere'))).toBe(true)
    expect(messages.some(m => m.includes('7'))).toBe(true)
    expect(messages.some(m => m.includes('emotions.broken') && m.includes('missing.gif'))).toBe(true)
  })

  it('没有任何候选文件的步骤被去掉，其余步骤保留并保持顺序', () => {
    touch('a.gif')
    touch('b.gif')

    const chain = resolve({
      portraits: { pixel: { emotions: { happy: ['a.gif'], sad: ['b.gif'], empty: [] } } },
      transitions: {
        'poke-neutral': [
          { from: 'emotions.happy', durationMs: 1000 },
          { from: 'emotions.empty', durationMs: 1000 },
          'not-an-object',
          { durationMs: 1000 },
          { from: 'emotions.sad', durationMs: 1000 },
        ],
      },
    })

    expect(chain.map(step => step.files)).toEqual([['a.gif'], ['b.gif']])
  })

  it('durationMs 缺失或不是正的有限数时设为 3000，并记日志', () => {
    touch('a.gif')
    const durations = [undefined, 0, -5, Infinity, '1000', null, 1500]

    const chain = resolve({
      portraits: { pixel: { emotions: { happy: ['a.gif'] } } },
      transitions: { 'poke-neutral': durations.map(durationMs => ({ from: 'emotions.happy', durationMs })) },
    })

    expect(chain.map(step => step.durationMs)).toEqual([3000, 3000, 3000, 3000, 3000, 3000, 1500])
    expect(warnings().filter(m => m.includes('durationMs'))).toHaveLength(6)
  })

  it('pick 没写或不在允许范围时规范为 random，并记日志', () => {
    touch('a.gif')

    const chain = resolve({
      portraits: { pixel: { emotions: { happy: ['a.gif'] } } },
      transitions: {
        'poke-neutral': [
          { from: 'emotions.happy', durationMs: 1000 },
          { from: 'emotions.happy', durationMs: 1000, pick: 'first' },
          { from: 'emotions.happy', durationMs: 1000, pick: 'random' },
        ],
      },
    })

    expect(chain.map(step => step.pick)).toEqual(['random', 'random', 'random'])
    expect(warnings().filter(m => m.includes('pick'))).toHaveLength(2)
  })

  it('按形态取文件组，另一个形态的同名文件组不参与', () => {
    touch('pixel.gif')
    touch('art.png')
    const raw = {
      portraits: {
        pixel: { emotions: { happy: ['pixel.gif'] } },
        illustration: { emotions: { happy: ['art.png'] } },
      },
      transitions: { 'poke-neutral': [{ from: 'emotions.happy', durationMs: 1000 }] },
    }

    expect(resolve(raw, 'poke-neutral', 'pixel')[0].files).toEqual(['pixel.gif'])
    expect(resolve(raw, 'poke-neutral', 'illustration')[0].files).toEqual(['art.png'])
  })

  it('不依赖 emotionVocabulary：词表里没有的键只要文件组存在就可用', () => {
    touch('a.gif')

    const chain = resolve({
      emotionVocabulary: [],
      portraits: { pixel: { emotions: { exotic: ['a.gif'] } } },
      transitions: { 'poke-neutral': [{ from: 'emotions.exotic', durationMs: 1000 }] },
    })

    expect(chain[0].files).toEqual(['a.gif'])
  })

  it('没有这个触发点、没有 transitions 或 raw 不是对象时返回空链且不告警', () => {
    expect(resolve({ transitions: { other: [] } })).toEqual([])
    expect(resolve({})).toEqual([])
    expect(resolve(null)).toEqual([])
    expect(resolve({ transitions: {} }, '__proto__')).toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('触发点的值不是数组时返回空链并记日志', () => {
    expect(resolve({ transitions: { 'poke-neutral': { from: 'emotions.happy' } } })).toEqual([])
    expect(warnings().some(m => m.includes('触发点 poke-neutral'))).toBe(true)
  })
})
