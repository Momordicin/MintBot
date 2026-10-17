// scripts/run-core-prod.mjs — 以 NODE_ENV=production 启动已构建的 core
// 用法：package.json 的 start 脚本；需先 pnpm build:core
// 对应文件：out/core/services/core/index.js / ecosystem.config.cjs

process.env.NODE_ENV = 'production'
await import('../out/core/services/core/index.js')
