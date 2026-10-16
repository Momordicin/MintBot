// services/core/routes/agents.ts — Claude Code / Codex 订阅登录状态与登录路由
// 用法：core/index.ts 注册 agentRoutes；GET /agents/status、POST /agents/:provider/login（provider 为 claude-code 或 codex）
// 对应文件：src/settings/SubscriptionLogin.tsx / services/core/agents/claudeCode.ts / services/core/agents/codex.ts
import type { FastifyInstance } from 'fastify'
import { getClaudeLoginStatus, launchClaudeLogin } from '../agents/claudeCode.js'
import { getCodexLoginStatus, launchCodexLogin } from '../agents/codex.js'

const LOGIN_BY_PROVIDER = {
  'claude-code': { launch: launchClaudeLogin, status: getClaudeLoginStatus },
  codex: { launch: launchCodexLogin, status: getCodexLoginStatus },
} as const

type AgentProvider = keyof typeof LOGIN_BY_PROVIDER

function isAgentProvider(value: string): value is AgentProvider {
  return Object.prototype.hasOwnProperty.call(LOGIN_BY_PROVIDER, value)
}

export async function agentRoutes(fastify: FastifyInstance) {
  fastify.get('/agents/status', async () => {
    const [claudeCode, codex] = await Promise.all([getClaudeLoginStatus(), getCodexLoginStatus()])
    return { claudeCode: { loggedIn: claudeCode }, codex: { loggedIn: codex } }
  })

  fastify.post<{ Params: { provider: string } }>('/agents/:provider/login', async (request, reply) => {
    const { provider } = request.params
    if (!isAgentProvider(provider)) {
      return reply.status(400).send({ error: 'provider 必须是 claude-code 或 codex' })
    }
    const { launch, status } = LOGIN_BY_PROVIDER[provider]
    try {
      await launch()
    } catch (err) {
      console.error('[Agents] login launch failed:', provider, err)
      return reply.status(500).send({ error: '无法启动登录窗口，请确认已安装对应命令行' })
    }
    return { loggedIn: await status() }
  })
}
