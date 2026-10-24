// services/core/errorLogging.ts — 把最终状态码为 5xx 的未捕获路由错误写入日志
// 用法：index.ts 在创建 Fastify 实例后、注册任何插件与路由之前调用 logServerErrors(fastify)
// 对应文件：services/core/index.ts / services/core/errorLogging.test.ts
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify'

export function logServerErrors(fastify: FastifyInstance): void {
  const routeErrors = new WeakMap<FastifyRequest, FastifyError>()
  fastify.addHook('onError', async (request, _reply, error) => {
    routeErrors.set(request, error)
  })
  fastify.addHook('onResponse', async (request, reply) => {
    const error = routeErrors.get(request)
    if (error !== undefined && reply.statusCode >= 500) {
      request.log.error({ err: error, method: request.method, url: request.url }, 'Unhandled route error')
    }
  })
}
