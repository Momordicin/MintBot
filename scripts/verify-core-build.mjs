// 编译产物存活性检查（build:core 之后自动跑一次）：`services/core` 与 `shared/` 之间的边界
// 此前只有类型层面的 import（`shared/` 曾经只放类型，编译期擦除，运行时从不真正解析这个
// specifier），所以哪怕相对路径在编译产物里根本无法解析，`pnpm typecheck`/`pnpm test`（跑的
// 都是源码或类型，不跑编译产物）也测不出来——直到 `shared/eventsLiveness.ts` 成为第一个从
// `shared/` 导入运行时值的模块，这类"tsc 不改写相对路径、但编译产物的目录结构与源码不一致"
// 的错误才会在 `node out/core/...` 真正加载时才炸出来（`ERR_MODULE_NOT_FOUND`）。这个脚本把
// 这一验证挪到 build 时：动态 import 每一个编译产物里真正引用了 shared/ 的文件，用 Node 原生
// ESM 解析（跟生产环境 `pm2 start ecosystem.config.cjs` 走的是同一套解析规则），编译产物一旦
// 又出现无法解析的 shared/ 引用就会在这里立刻炸掉，而不是等到部署上线才发现
//
// 不 import 完整的 out/core/services/core/index.js：那个入口有真正的副作用（监听端口、
// 初始化数据库、按需拉起 ollama/AI 子进程），不适合作为一次性检查跑；只 import 真正跨越
// shared/ 边界的模块就足够验证"这条 import specifier 能否被 Node 原生解析"这件事本身
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const OUT_CORE_DIR = path.resolve(import.meta.dirname, '..', 'out', 'core')
const SHARED_IMPORT_PATTERN = /from\s+['"][^'"]*\/shared\/[^'"]+['"]/

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

async function main() {
  const compiledFiles = await findCompiledFiles(OUT_CORE_DIR)
  const filesImportingShared = []
  for (const file of compiledFiles) {
    const content = await readFile(file, 'utf-8')
    if (SHARED_IMPORT_PATTERN.test(content)) filesImportingShared.push(file)
  }

  if (filesImportingShared.length === 0) {
    console.error(
      '[verify-core-build] Expected at least one compiled services/core file to import from shared/, found none. ' +
        'Either the shared/ boundary was removed (update this check) or the scan pattern is stale.',
    )
    process.exit(1)
  }

  let failed = false
  for (const file of filesImportingShared) {
    const relPath = path.relative(process.cwd(), file)
    try {
      await import(pathToFileURL(file).href)
      console.log(`[verify-core-build] OK: ${relPath}`)
    } catch (err) {
      failed = true
      console.error(`[verify-core-build] FAILED to load ${relPath}:`, err)
    }
  }

  if (failed) {
    console.error(
      '[verify-core-build] A compiled services/core module could not be loaded under plain Node ESM resolution. ' +
        'This is the exact failure mode ecosystem.config.cjs hits in production (`pm2 start ecosystem.config.cjs` runs ' +
        'out/core/services/core/index.js with plain `node`). Check services/core/tsconfig.json rootDir/outDir and any ' +
        'relative imports crossing into shared/.',
    )
    process.exit(1)
  }

  console.log('[verify-core-build] All compiled services/core modules importing shared/ load cleanly.')
}

main()
