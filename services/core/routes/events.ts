import type { FastifyInstance } from 'fastify'
import { registerEventsClient, sendHello } from '../events/broadcast.js'

// 共享 SSE 广播流（TDD §3.3「SSE 事件类型规范」）：跟具体请求无关、需要多窗口同步感知的
// 状态事件（emotion、system 的广播半边、未来的 proactive）统一走这条连接。客户端的实际状态
// 仍然由 GET /state、GET /config/window-behavior 等既有端点负责，这条流不携带任何状态负载
// 本身——它只管两件事：① 之后发生的变化（emotion/preset-switched/window-behavior-changed
// 等广播）；② 通过 hello/heartbeat 帧告诉客户端"我是不是还是你上次连上的那个核心服务进程"，
// 供客户端打一行诊断日志（见 sendHello、broadcast.ts 的 SERVER_GENERATION/
// HEARTBEAT_INTERVAL_MS）——是否收敛由客户端"这条连接是否刚建立/重连"决定，不由这个
// generation 决定，见 docs/MintBot_TDD.md §3.3「服务器代次与状态收敛」。
//
// ⚠️ 反转记录：此前这里的注释是"连接建立后不发送任何初始事件"。那是状态收敛模型落地之前的
// 决定，本次改动明确推翻它——连接建立后立即发送一帧 hello（下面 sendHello 调用），之后每
// HEARTBEAT_INTERVAL_MS 还会收到一次广播的 heartbeat，两者都携带 SERVER_GENERATION。这个
// 反转不违反"初始状态由 GET /state 负责"这条决定：hello/heartbeat 帧的 data 只有
// { generation }，不携带任何业务状态字段，客户端拿到它之后如果判断需要收敛，做的仍然是
// 重新调用 GET /state / GET /config/window-behavior 等既有端点，而不是从这帧本身读到状态
export async function eventsRoutes(fastify: FastifyInstance) {
  fastify.get('/events', async (_request, reply) => {
    reply.raw.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173')
    reply.raw.setHeader('Content-Type', 'text/event-stream')
    reply.raw.setHeader('Cache-Control', 'no-cache')
    reply.raw.setHeader('Connection', 'keep-alive')
    reply.raw.flushHeaders()

    registerEventsClient(reply)
    sendHello(reply)
    // 不调用 reply.send()/reply.raw.end()：这条连接需要一直保持打开，直到客户端主动断开
    // （由 broadcast.ts 自己的 close 监听器负责清理），不像 /chat 那样有天然的请求处理终点
  })
}
