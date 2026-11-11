// services/core/roleConfig/hotwords.test.ts — 错写表的段生成、按角色编号覆盖、完整性判断的测试（只测字符串）
// 用法：pnpm test；mock voice/agent.js
// 对应文件：services/core/roleConfig/hotwords.ts
import { describe, expect, it, vi } from 'vitest'

vi.mock('../voice/agent.js', () => ({ hotwordsPath: () => '' }))

import { buildSection, isComplete, upsertSection } from './hotwords.js'

describe('buildSection', () => {
  const cases: { title: string; entries: { name: string; misspellings: string[] }[]; expected: string[] }[] = [
    {
      title: '去掉空的、与称呼相同的（不区分大小写）、重复的、含 | 的、以 # 开头的错写',
      entries: [{ name: 'Aemeath', misspellings: ['', '  ', 'aemeath', 'Eith', ' Eith', 'a|b', '#Emith', 'Emith'] }],
      expected: ['Aemeath | Eith | Emith'],
    },
    { title: '没有错写时只写称呼', entries: [{ name: '爱弥斯', misspellings: [] }], expected: ['爱弥斯'] },
  ]

  it.each(cases)('$title', ({ entries, expected }) => {
    expect(buildSection('爱弥斯', '2026-11-10', 'id-1', entries)).toBe(['# 爱弥斯 2026-11-10 id-1', ...expected].join('\n'))
  })
})

describe('upsertSection', () => {
  const sectionA = '# 甲 2026-11-10 id-a\n甲 | 假'
  const sectionB = '# 乙 2026-11-09 id-b\n乙'
  const sectionC = '# 丙 2026-11-08 id-c\n丙'
  const sectionNew = '# 甲 2026-11-11 id-a\n新'
  const cases: { title: string; text: string; expected: string }[] = [
    { title: '没有这个角色的段时追加到末尾', text: `${sectionB}\n`, expected: `${sectionB}\n${sectionNew}\n` },
    {
      title: '有这个角色的段时整段覆盖，前后其他角色的段不变',
      text: `${sectionB}\n${sectionA}\n额外\n${sectionC}\n`,
      expected: `${sectionB}\n${sectionNew}\n${sectionC}\n`,
    },
  ]

  it.each(cases)('$title', ({ text, expected }) => {
    expect(upsertSection(text, 'id-a', sectionNew)).toBe(expected)
  })
})

describe('isComplete', () => {
  const text = '# 乙 2026-11-09 id-b\n乙\n# 甲 2026-11-10 id-a\n甲 | 假\n飞行雪绒\n'
  const cases: { title: string; id: string; names: string[]; expected: boolean }[] = [
    { title: '每个称呼都有一行', id: 'id-a', names: ['甲', '飞行雪绒'], expected: true },
    { title: '缺一个称呼', id: 'id-a', names: ['甲', '丙'], expected: false },
    { title: '没有这个角色的段', id: 'id-z', names: ['甲'], expected: false },
  ]

  it.each(cases)('$title', ({ id, names, expected }) => {
    expect(isComplete(text, id, names)).toBe(expected)
  })
})
