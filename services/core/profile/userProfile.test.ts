import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import { USER_PROFILE_PATH, getLocation, setLocation } from './userProfile.js'

beforeEach(() => {
  fs.rmSync(USER_PROFILE_PATH, { force: true })
  fs.rmSync(`${USER_PROFILE_PATH}.tmp`, { force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('userProfile 所在地', () => {
  it('文件不存在时 getLocation 返回 null', () => {
    expect(getLocation()).toBeNull()
  })

  it('setLocation 后 getLocation 读回同样的值，文件以固定格式创建', () => {
    setLocation({ value: '中国上海市徐汇区', userInput: '徐汇' })

    const location = getLocation()
    expect(location?.value).toBe('中国上海市徐汇区')
    expect(location?.userInput).toBe('徐汇')
    expect(location?.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)

    const text = fs.readFileSync(USER_PROFILE_PATH, 'utf8')
    expect(text.startsWith('# 用户资料\n\n## 所在地\n- 当前：中国上海市徐汇区\n- 用户原话：徐汇\n- 记下时间：')).toBe(true)
    expect(text).not.toContain('\r')
    expect(fs.existsSync(`${USER_PROFILE_PATH}.tmp`)).toBe(false)
  })

  it('再次 setLocation 只替换所在地段落，其他内容原样保留', () => {
    fs.writeFileSync(
      USER_PROFILE_PATH,
      '# 用户资料\n\n## 称呼\n- 昵称：小明\n\n## 所在地\n- 当前：旧地方\n- 用户原话：旧\n- 记下时间：2026-01-01T00:00:00+08:00\n\n## 备注\n手写的内容\n',
      'utf8'
    )

    setLocation({ value: '中国北京市海淀区', userInput: '搬到海淀了' })

    const text = fs.readFileSync(USER_PROFILE_PATH, 'utf8')
    expect(text).toContain('# 用户资料\n\n## 称呼\n- 昵称：小明\n\n## 所在地\n- 当前：中国北京市海淀区\n- 用户原话：搬到海淀了\n- 记下时间：')
    expect(text).toContain('\n\n## 备注\n手写的内容\n')
    expect(text).not.toContain('旧地方')
    expect(getLocation()?.value).toBe('中国北京市海淀区')
  })

  it('文件存在但没有所在地段落时，追加段落并保留原内容', () => {
    fs.writeFileSync(USER_PROFILE_PATH, '# 用户资料\n\n## 称呼\n- 昵称：小明\n', 'utf8')

    expect(getLocation()).toBeNull()
    setLocation({ value: '中国上海市', userInput: '上海' })

    const text = fs.readFileSync(USER_PROFILE_PATH, 'utf8')
    expect(text.startsWith('# 用户资料\n\n## 称呼\n- 昵称：小明\n\n## 所在地\n- 当前：中国上海市\n')).toBe(true)
  })

  it('所在地段落缺字段时返回 null 且只记一条警告，不抛错', () => {
    fs.writeFileSync(USER_PROFILE_PATH, '# 用户资料\n\n## 所在地\n- 当前：中国上海市\n', 'utf8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(getLocation()).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('写入时多行内容被压成单行，不会破坏文档结构', () => {
    setLocation({ value: '中国上海市\n## 伪造段落', userInput: '上海\r\n- 当前：别处' })

    const location = getLocation()
    expect(location?.value).toBe('中国上海市 ## 伪造段落')
    expect(location?.userInput).toBe('上海 - 当前：别处')
  })

  it('重命名前失败时原文件保持不变，临时文件被清理，错误向上抛出', () => {
    setLocation({ value: '中国上海市', userInput: '上海' })
    const before = fs.readFileSync(USER_PROFILE_PATH, 'utf8')
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('rename boom')
    })

    expect(() => setLocation({ value: '中国北京市', userInput: '北京' })).toThrow('rename boom')

    expect(fs.readFileSync(USER_PROFILE_PATH, 'utf8')).toBe(before)
    expect(fs.existsSync(`${USER_PROFILE_PATH}.tmp`)).toBe(false)
  })

  it('VITEST 下 USER_PROFILE_PATH 不在系统临时目录内时模块加载直接抛错', async () => {
    vi.resetModules()
    vi.stubEnv('USER_PROFILE_PATH', './data/user-profile.md')

    await expect(import('./userProfile.js')).rejects.toThrow(/refusing USER_PROFILE_PATH/)
  })
})
