// scripts/verifyCoreBuildCheck.mjs
// 用途：verify-core-build 的静态检查实现——从编译产物里抽取相对 specifier，并按 Node ESM 规则检查目标文件是否存在；绝不执行被检查的模块
// 用法：scripts/verify-core-build.mjs 调用 verifyCompiledImports；scripts/verify-core-build.test.ts 直接测试这里的导出
// 对应方：scripts/verify-core-build.mjs（入口，无条件运行 main）
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_OUT_CORE_DIR = path.resolve(import.meta.dirname, '..', 'out', 'core')
const SPECIFIER_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

async function findCompiledFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await findCompiledFiles(fullPath)))
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      files.push(fullPath)
    }
  }
  return files
}

export function extractRelativeSpecifiers(source) {
  const found = new Set()
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      if (match[1].startsWith('./') || match[1].startsWith('../')) found.add(match[1])
    }
  }
  return [...found]
}

async function isRegularFile(filePath) {
  try {
    return (await stat(filePath)).isFile()
  } catch {
    return false
  }
}

export async function verifyCompiledImports(outDir = DEFAULT_OUT_CORE_DIR) {
  const files = await findCompiledFiles(outDir)
  const errors = []
  let sharedSpecifiers = 0
  for (const file of files) {
    const specifiers = extractRelativeSpecifiers(await readFile(file, 'utf-8'))
    for (const specifier of specifiers) {
      if (specifier.includes('/shared/')) sharedSpecifiers++
      let resolved = false
      try {
        resolved = await isRegularFile(fileURLToPath(new URL(specifier, pathToFileURL(file))))
      } catch {}
      if (!resolved) {
        errors.push(`${path.relative(process.cwd(), file)}: '${specifier}' does not resolve to a file`)
      }
    }
  }
  return { fileCount: files.length, sharedSpecifiers, errors }
}
