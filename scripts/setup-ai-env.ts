// 初始化仓库根目录 .venv（Python 虚拟环境，用于运行 services/ai 的 FastAPI 服务），
// 并安装/同步 services/ai/requirements.txt 依赖。运行方式：pnpm setup:ai（首次 clone 后跑一次；
// requirements.txt 更新后重新跑一次以同步依赖）。venv 已存在时跳过创建，但 pip install 总会
// 重新执行一次，保证依赖与 requirements.txt 保持同步。

import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const VENV_DIR = path.resolve(process.cwd(), '.venv')
const VENV_PYTHON = path.join(VENV_DIR, 'Scripts', 'python.exe')
const VENV_PIP = path.join(VENV_DIR, 'Scripts', 'pip.exe')
const REQUIREMENTS_PATH = path.resolve(process.cwd(), 'services/ai/requirements.txt')

function main(): void {
  if (process.platform !== 'win32') {
    throw new Error(`setup-ai-env 目前只支持 Windows，当前平台是 ${process.platform}，暂不支持`)
  }

  if (!fs.existsSync(VENV_PYTHON)) {
    console.log(`[setup-ai-env] 未找到 ${VENV_PYTHON}，创建虚拟环境...`)
    try {
      execFileSync('python', ['-m', 'venv', VENV_DIR], { stdio: 'inherit' })
    } catch (err) {
      throw new Error(
        `创建虚拟环境失败，请确认已安装 Python 且 python 命令在 PATH 上可用。原始错误：${err}`
      )
    }
  } else {
    console.log(`[setup-ai-env] 已存在 ${VENV_PYTHON}，跳过创建`)
  }

  console.log(`[setup-ai-env] 安装依赖 ${REQUIREMENTS_PATH}...`)
  execFileSync(VENV_PIP, ['install', '-r', REQUIREMENTS_PATH], { stdio: 'inherit' })

  console.log('[setup-ai-env] 完成')
}

try {
  main()
} catch (err) {
  console.error('[setup-ai-env] failed:', err)
  process.exit(1)
}
