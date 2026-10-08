// vitest.env.ts — 测试环境变量加载入口，保证 .env.test 在任何读取 process.env 的模块求值之前生效
//
// 用法：在 vitest.config.ts 顶部以副作用方式 import，且必须排在 services/core/config/ports.ts 之前
// 配套文件：vitest.config.ts / vitest.setup.ts / .env.test

import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.test', quiet: true, override: true })
