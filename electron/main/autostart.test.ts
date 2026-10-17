// electron/main/autostart.test.ts — loginItemOptions 与 hasAutostartFlag 的参数构造与识别测试
//
// 用法：pnpm test
// 配套文件：electron/main/autostart.ts

import { describe, it, expect } from 'vitest'
import { AUTOSTART_FLAG, hasAutostartFlag, loginItemOptions } from './autostart'

describe('loginItemOptions', () => {
  it('path 为可执行文件，args 依次为加引号的应用目录与 --autostart', () => {
    expect(loginItemOptions('C:\\app\\electron.exe', 'E:\\LLM\\MintBot')).toEqual({
      path: 'C:\\app\\electron.exe',
      args: ['"E:\\LLM\\MintBot"', '--autostart'],
    })
  })

  it('应用目录含空格时整体被引号包住', () => {
    expect(loginItemOptions('C:\\app\\electron.exe', 'C:\\Program Files\\Mint Bot').args).toEqual(['"C:\\Program Files\\Mint Bot"', '--autostart'])
  })
})

describe('hasAutostartFlag', () => {
  it('argv 含 --autostart 时为真', () => {
    expect(hasAutostartFlag(['electron.exe', 'E:\\LLM\\MintBot', AUTOSTART_FLAG])).toBe(true)
  })

  it('应用目录含空格、命令行拆分去掉引号后仍识别 --autostart', () => {
    const { path, args } = loginItemOptions('C:\\app\\electron.exe', 'C:\\Program Files\\Mint Bot')
    expect(hasAutostartFlag([path, args[0].slice(1, -1), args[1]])).toBe(true)
  })

  it('argv 不含 --autostart 时为假', () => {
    expect(hasAutostartFlag(['electron.exe', '.'])).toBe(false)
  })

  it('只匹配完整参数，不匹配前缀或子串', () => {
    expect(hasAutostartFlag(['--autostart-x', 'autostart'])).toBe(false)
  })
})
