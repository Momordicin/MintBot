import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import fastifyCors from '@fastify/cors'

// 与 index.ts 里 @fastify/cors 的注册配置保持一致（index.ts 未导出可复用的 build-app
// 工厂，这里按 static.test.ts 的既有约定在测试里复制同一份配置，而不是重新 new 一个
// 服务实例并 listen）。这个测试要覆盖的正是"配置是否让浏览器的真实预检通过"，因此
// 不能只断言配置对象字面量包含 'PATCH'——必须真的发一个 OPTIONS 预检请求，走
// @fastify/cors 自己的解析逻辑，才能捕获本次修复之前的那个 bug（默认值 'GET,HEAD,POST'
// 不含 PATCH，导致 PATCH /presets/:presetId 的预检被浏览器拒绝，请求根本到不了服务端）
async function buildTestApp() {
  const fastify = Fastify()
  await fastify.register(fastifyCors, {
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'HEAD', 'POST', 'PATCH'],
  })
  fastify.patch('/presets/:presetId', async () => ({ ok: true }))
  return fastify
}

describe('CORS 预检 (OPTIONS)', () => {
  it('允许的 origin 对 PATCH 方法的预检请求，响应头包含 PATCH', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({
      method: 'OPTIONS',
      url: '/presets/p1',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'PATCH',
      },
    })

    expect(response.statusCode).toBe(204)
    expect(response.headers['access-control-allow-methods']).toContain('PATCH')
  })
})
