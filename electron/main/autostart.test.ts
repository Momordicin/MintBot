// electron/main/autostart.test.ts — loginItemOptions 与 hasAutostartFlag 的参数构造与识别测试
//
// 用法：pnpm test
// 配套文件：electron/main/autostart.ts

import { describe, it, expect } from 'vitest'
import { AUTOSTART_FLAG, hasAutostartFlag, legacyLoginItemOptions, loginItemOptions, shouldMigrateAutostart } from './autostart'

describe('loginItemOptions', () => {
  it('path 为可执行文件，args 依次为原样应用目录与 --autostart', () => {
    expect(loginItemOptions('C:\\app\\electron.exe', 'E:\\LLM\\MintBot')).toEqual({
      path: 'C:\\app\\electron.exe',
      args: ['E:\\LLM\\MintBot', '--autostart'],
    })
  })

  it('应用目录含空格和中文时不手动加引号（引号由 Electron 添加）', () => {
    const { args } = loginItemOptions('C:\\app\\electron.exe', 'C:\\测试 目录\\Mint Bot')
    expect(args).toEqual(['C:\\测试 目录\\Mint Bot', '--autostart'])
    expect(args[0]).toContain('\\')
  })
})

describe('legacyLoginItemOptions', () => {
  it('args 为加引号的应用目录与 --autostart，用于识别旧版登录项', () => {
    expect(legacyLoginItemOptions('C:\\app\\electron.exe', 'C:\\测试 目录\\Mint Bot')).toEqual({
      path: 'C:\\app\\electron.exe',
      args: ['"C:\\测试 目录\\Mint Bot"', '--autostart'],
    })
  })
})

describe('shouldMigrateAutostart', () => {
  it('非开发模式且旧版登录项存在时迁移', () => {
    expect(shouldMigrateAutostart(false, true)).toBe(true)
  })

  it('旧版登录项不存在时不迁移', () => {
    expect(shouldMigrateAutostart(false, false)).toBe(false)
  })

  it('开发模式不迁移', () => {
    expect(shouldMigrateAutostart(true, true)).toBe(false)
  })
})

describe('hasAutostartFlag', () => {
  it('argv 含 --autostart 时为真', () => {
    expect(hasAutostartFlag(['electron.exe', 'E:\\LLM\\MintBot', AUTOSTART_FLAG])).toBe(true)
  })

  it('应用目录含空格时，按登录项参数组成的 argv 仍识别 --autostart', () => {
    const { path, args } = loginItemOptions('C:\\app\\electron.exe', 'C:\\Program Files\\Mint Bot')
    expect(hasAutostartFlag([path, ...args])).toBe(true)
  })

  it('argv 不含 --autostart 时为假', () => {
    expect(hasAutostartFlag(['electron.exe', '.'])).toBe(false)
  })

  it('只匹配完整参数，不匹配前缀或子串', () => {
    expect(hasAutostartFlag(['--autostart-x', 'autostart'])).toBe(false)
  })
})
