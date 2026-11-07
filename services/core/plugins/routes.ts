// services/core/plugins/routes.ts — 插件页的读取与操作路由
// 用法：core/index.ts 里 fastify.register(pluginRoutes)；GET /plugins、GET /plugins/:name/latest、POST /plugins/:name/install（202）、POST /plugins/:name/force-enable、POST /plugins/:name/cancel-force-enable、PUT /plugins/:name/config（体为 { config }），由 src/settings/PluginsPanel.tsx 调用；状态变化时 SSE 事件 plugins-changed
// 对应文件：services/core/plugins/manager.ts / src/settings/PluginsPanel.tsx / shared/errorCodes.ts
import type { FastifyInstance } from 'fastify'
import { errorBody } from '../../../shared/errorCodes.js'
import {
  PluginOperationError,
  cancelForceEnablePlugin,
  fetchLatestVersion,
  forceEnablePlugin,
  getPluginsSnapshot,
  savePluginConfig,
  startPluginInstall,
} from './manager.js'

export async function pluginRoutes(fastify: FastifyInstance) {
  fastify.get('/plugins', async () => ({ plugins: getPluginsSnapshot() }))

  fastify.get<{ Params: { name: string } }>('/plugins/:name/latest', async (request, reply) => {
    try {
      return reply.status(200).send({ version: await fetchLatestVersion(request.params.name) })
    } catch (err) {
      if (err instanceof PluginOperationError) return reply.status(err.status).send(errorBody(err.errorCode))
      throw err
    }
  })

  fastify.post<{ Params: { name: string } }>('/plugins/:name/install', async (request, reply) => {
    try {
      startPluginInstall(request.params.name)
    } catch (err) {
      if (err instanceof PluginOperationError) return reply.status(err.status).send(errorBody(err.errorCode))
      throw err
    }
    return reply.status(202).send({ ok: true })
  })

  fastify.post<{ Params: { name: string } }>('/plugins/:name/force-enable', async (request, reply) => {
    try {
      await forceEnablePlugin(request.params.name)
    } catch (err) {
      if (err instanceof PluginOperationError) return reply.status(err.status).send(errorBody(err.errorCode))
      throw err
    }
    return reply.status(200).send({ ok: true })
  })

  fastify.post<{ Params: { name: string } }>('/plugins/:name/cancel-force-enable', async (request, reply) => {
    try {
      await cancelForceEnablePlugin(request.params.name)
    } catch (err) {
      if (err instanceof PluginOperationError) return reply.status(err.status).send(errorBody(err.errorCode))
      throw err
    }
    return reply.status(200).send({ ok: true })
  })

  fastify.put<{ Params: { name: string }; Body: { config?: unknown } }>('/plugins/:name/config', async (request, reply) => {
    try {
      savePluginConfig(request.params.name, request.body?.config)
    } catch (err) {
      if (err instanceof PluginOperationError) return reply.status(err.status).send(errorBody(err.errorCode))
      throw err
    }
    return reply.status(200).send({ ok: true })
  })
}
