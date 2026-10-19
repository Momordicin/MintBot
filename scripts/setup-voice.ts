// scripts/setup-voice.ts — 安装可选的语音组件（mintbot-voice-agent）到 data/voice-agent/
// 用法：pnpm setup:voice --manifest <路径或网址>
// 对应文件：services/core/voice/install.ts / services/core/voice/agent.ts / package.json
import { installVoice } from '../services/core/voice/install.js'

function readManifestArg(): string {
  const index = process.argv.indexOf('--manifest')
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) {
    throw new Error('缺少参数：pnpm setup:voice --manifest <路径或网址>')
  }
  return value
}

async function main() {
  const installation = await installVoice(readManifestArg(), msg => console.log(`[setup-voice] ${msg}`))
  console.log(`[setup-voice] 完成：版本 ${installation.version}，${installation.exe}`)
}

main().catch(err => {
  console.error('[setup-voice] failed:', err)
  process.exit(1)
})
