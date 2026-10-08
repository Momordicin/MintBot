import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// 守卫测试（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"Placement：用户的「家」与自动避让
// 的位置彻底分离"一节的不变量："自动避让只修改 currentDisplayId 并置
// temporaryRelocation = true，永远不写入任何偏好"）。
//
// windowPositions.ts 的原始 setter（writeHomeDisplayId）已不导出——模块系统已经把"只能从一个
// 门写这个字段"变成编译期事实。这里额外守卫的是它唯一的导出门 commitUserChosenHomeDisplay：
// 用 import 边界检查确认整个 electron/main 目录下只有 homeDisplayCommit.ts 一个文件 import
// 了它。
//
// 抓得住什么：任何人在任意文件里新增第二处对 commitUserChosenHomeDisplay 的具名 import——
// 包括"把调用从拖拽路径搬进 evaluatePetPresence/evaluateChatPresence（windowBehavior.ts）"
// 这种回归：要做到这一点，windowBehavior.ts 就必须自己新增一条 import，而它现在完全不
// import 这个符号，新增的 import 会让下面的断言失败。这正是任务要求解决的"file-scoped 正则
// 抓不到同文件内调用点搬家"的问题——因为这里不再需要定位调用点在哪个函数体内，只需要看
// import 语句本身。
//
// 抓不住什么：① 绕开具名 import 的写法（例如 require() 动态引入、字符串反射调用）；
// ② homeDisplayCommit.ts 内部本身新增一条不经过 outcome.newPreferredDisplayId 判断、无条件
// 调用 commitUserChosenHomeDisplay 的分支——这条检查只看"谁 import 了这个符号"，不检查
// 该文件内部调用点的上下文是否仍然只在真实拖拽结果为真时触发。
const MAIN_DIR = __dirname
const TARGET_SYMBOL = 'commitUserChosenHomeDisplay'
const SOURCE_MODULE = './windowPositions'
const EXPECTED_SOLE_IMPORTER = 'homeDisplayCommit.ts'

function listSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full)
    }
  }
  return files
}

function importsTargetSymbol(fileContent: string): boolean {
  // 匹配形如 import { ..., commitUserChosenHomeDisplay, ... } from './windowPositions' 的
  // 具名 import——同时要求命中符号名与来源路径，避免误判到别的同名局部变量/字符串
  const importRegex = new RegExp(
    `import\\s*\\{[^}]*\\b${TARGET_SYMBOL}\\b[^}]*\\}\\s*from\\s*['"]${SOURCE_MODULE.replace('.', '\\.')}['"]`
  )
  return importRegex.test(fileContent)
}

describe('commitUserChosenHomeDisplay import boundary', () => {
  it('is imported by exactly one module: homeDisplayCommit.ts', () => {
    const files = listSourceFiles(MAIN_DIR)
    const importers = files.filter(file => importsTargetSymbol(fs.readFileSync(file, 'utf-8')))

    expect(importers.map(file => path.basename(file))).toEqual([EXPECTED_SOLE_IMPORTER])
  })
})
