// 编译产物静态解析检查（build:core 之后自动跑一次）：`services/core` 与 `shared/` 之间的边界
// 此前只有类型层面的 import（`shared/` 曾经只放类型，编译期擦除，运行时从不真正解析这个
// specifier），所以哪怕相对路径在编译产物里根本无法解析，`pnpm typecheck`/`pnpm test`（跑的
// 都是源码或类型，不跑编译产物）也测不出来——直到 `shared/eventsLiveness.ts` 成为第一个从
// `shared/` 导入运行时值的模块，这类"tsc 不改写相对路径、但编译产物的目录结构与源码不一致"
// 的错误才会在 `node out/core/...` 真正加载时才炸出来（`ERR_MODULE_NOT_FOUND`）。
//
// 这个脚本只做静态检查，绝不 import / 执行任何编译产物：扫描 out/core 下（services/core 与 shared 两份
// 产物，跳过 *.test.js）每个 .js 里的相对 specifier（`from '...'`、`import '...'`、`export ... from '...'`、
// 字符串字面量的 `import('...')`），按 Node ESM 对相对 specifier 的规则解析（不补扩展名、不查 index），
// 目标不存在或不是普通文件就失败。bare 与 `node:` specifier 不在范围内。
// 之所以不能执行：此前的版本动态 import 这些模块，而 db/index.ts 在模块顶层就会打开真实的
// ./data/db.sqlite，一次 build 就碰到了真实数据库
import { verifyCompiledImports } from './verifyCoreBuildCheck.mjs'

async function main() {
  const { fileCount, sharedSpecifiers, errors } = await verifyCompiledImports()

  if (fileCount === 0 || sharedSpecifiers === 0) {
    console.error(
      '[verify-core-build] Expected compiled files under out/core with at least one import crossing into shared/, found none. ' +
        'Either the shared/ boundary was removed (update this check) or the scan pattern is stale.',
    )
    process.exit(1)
  }

  if (errors.length > 0) {
    for (const message of errors) console.error(`[verify-core-build] FAILED: ${message}`)
    console.error(
      '[verify-core-build] A compiled module has a relative import that plain Node ESM resolution cannot find. ' +
        'This is the exact failure mode ecosystem.config.cjs hits in production (`pm2 start ecosystem.config.cjs` runs ' +
        'out/core/services/core/index.js with plain `node`). Check services/core/tsconfig.json rootDir/outDir and any ' +
        'relative imports crossing into shared/.',
    )
    process.exit(1)
  }

  console.log(`[verify-core-build] OK: ${fileCount} compiled files, ${sharedSpecifiers} shared/ imports, all relative imports resolve.`)
}

main()
