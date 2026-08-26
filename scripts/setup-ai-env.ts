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

  // 预下载模型权重（bge-m3 + bert4ner），不只是装 Python 包——BGEM3FlagModel /
  // AutoModelForTokenClassification 首次实例化时会从 HuggingFace 下载权重（bge-m3 完整仓库
  // ~4.59GB），如果这个下载留到 core 服务启动后的 embedding 预热才第一次触发，会在一个
  // 用户看不到进度、且客户端只等 30 秒就放弃的请求里发生，表现成一次"预热失败"的误导性日志，
  // 而模型本身其实还在后台继续下载。挪到这里作为一次显式、前台可见、预期本来就要等的步骤，
  // 下载完成后本地会有缓存（~/.cache/huggingface/），下次 setup:ai 重新跑这一步会很快跳过下载
  console.log('[setup-ai-env] 预下载模型权重（bge-m3 + bert4ner，仅首次需要下载，之后走本地缓存）...')
  const PRELOAD_SCRIPT = [
    "from FlagEmbedding import BGEM3FlagModel",
    "BGEM3FlagModel('BAAI/bge-m3', use_fp16=True)",
    "print('[setup-ai-env] bge-m3 weights ready')",
    "from transformers import AutoTokenizer, AutoModelForTokenClassification",
    "AutoTokenizer.from_pretrained('shibing624/bert4ner-base-chinese')",
    "AutoModelForTokenClassification.from_pretrained('shibing624/bert4ner-base-chinese')",
    "print('[setup-ai-env] bert4ner-base-chinese weights ready')",
  ].join('\n')
  execFileSync(VENV_PYTHON, ['-c', PRELOAD_SCRIPT], { stdio: 'inherit' })

  console.log('[setup-ai-env] 完成')
}

try {
  main()
} catch (err) {
  console.error('[setup-ai-env] failed:', err)
  process.exit(1)
}
