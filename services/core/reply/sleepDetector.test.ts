import { describe, it, expect } from 'vitest'
import { detectSleepiness } from './sleepDetector.js'

describe('sleepDetector: 第 1 层——非困倦义词形不误报', () => {
  it('困难', () => {
    expect(detectSleepiness('这道题好困难')).toBe(false)
  })

  it('困惑', () => {
    expect(detectSleepiness('我对这件事感到很困惑')).toBe(false)
  })

  it('困扰', () => {
    expect(detectSleepiness('这件事一直困扰着我')).toBe(false)
  })
})

describe('sleepDetector: 第 3 层——第二人称排除', () => {
  it('你困了吗（最高频误报来源）', () => {
    expect(detectSleepiness('你困了吗')).toBe(false)
  })

  it('您困了就早点休息', () => {
    expect(detectSleepiness('您困了就早点休息吧')).toBe(false)
  })

  it('跨小句干扰：你困了吗，我还挺精神——第二人称只排除同一小句，不误伤下一小句', () => {
    expect(detectSleepiness('你困了吗，我还挺精神')).toBe(false)
  })
})

describe('sleepDetector: 第 4 层——否定排除', () => {
  it('我不困', () => {
    expect(detectSleepiness('我不困')).toBe(false)
  })

  it('我没有困', () => {
    expect(detectSleepiness('我没有困')).toBe(false)
  })
})

describe('sleepDetector: 第 4 层——正向匹配，直陈家族', () => {
  it.each(['困了', '好困', '有点困', '太困了', '困死了', '犯困'])('%s', pattern => {
    expect(detectSleepiness(`我${pattern}`)).toBe(true)
  })
})

describe('sleepDetector: 第 4 层——正向匹配，睡意家族', () => {
  it.each(['想睡', '想睡觉', '要睡了', '该睡了'])('%s', pattern => {
    expect(detectSleepiness(`我${pattern}`)).toBe(true)
  })
})

describe('sleepDetector: 第 4 层——正向匹配，体感家族', () => {
  it.each(['眼皮打架', '撑不住了', '打哈欠'])('%s', pattern => {
    expect(detectSleepiness(`我${pattern}`)).toBe(true)
  })
})

describe('sleepDetector: 无信号', () => {
  it('普通回复不命中', () => {
    expect(detectSleepiness('今天天气不错呢')).toBe(false)
  })
})

describe('sleepDetector: 已知残留（规则层面解决不了，记录不修，TDD §3.8）', () => {
  it('第三人称引述会误报——规则无法区分"角色自己困"与"转述别人困"', () => {
    expect(detectSleepiness('他说他困了')).toBe(true)
  })

  it('语义否定的复杂形式——本实现里「困是困」不在正向模式表内，字面也不命中；这里只是把当前行为钉死，不代表规则理解了这句话的语义', () => {
    expect(detectSleepiness('困是困，但还能撑')).toBe(false)
  })
})

describe('detectSleepiness: 否定排除（真正触及否定分支的用例）', () => {
  // 「我不困」「我没有困」虽然也返回 false，但它们是空跑的——正向模式表里没有裸的「困」，
  // 这两句压根匹配不上任何模式，根本走不到否定判断。下面几条都含有确实会命中模式表的子串，
  // 是唯一能真正验证第 4 层否定分支的写法
  it('多字否定词：我没有犯困（命中「犯困」，前一个字是「有」而非否定字）', () => {
    expect(detectSleepiness('我没有犯困')).toBe(false)
  })

  it('多字否定词：我没有想睡（命中「想睡」）', () => {
    expect(detectSleepiness('我没有想睡')).toBe(false)
  })

  it('否定词与命中之间隔着内容：我一点都不犯困', () => {
    expect(detectSleepiness('我一点都不犯困')).toBe(false)
  })

  it('同一小句内没有否定词时照常命中：我今天有点困了', () => {
    expect(detectSleepiness('我今天有点困了')).toBe(true)
  })

  it('否定词在别的小句里不影响本句命中：今天不忙，我好困', () => {
    expect(detectSleepiness('今天不忙，我好困')).toBe(true)
  })
})
