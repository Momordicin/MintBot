import { describe, it, expect } from 'vitest'
import path from 'path'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'

async function buildTestApp() {
  const fastify = Fastify()
  await fastify.register(fastifyStatic, {
    root: path.resolve(process.cwd(), 'assets/characters'),
    prefix: '/characters/',
    decorateReply: false,
  })
  return fastify
}

describe('GET /characters/*', () => {
  it('返回 assets/characters/ 下角色包的 manifest.json 内容', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/characters/example/manifest.json' })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.payload)
    expect(body).toHaveProperty('avatar')
  })

  it('不存在的角色包路径返回 404', async () => {
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/characters/does-not-exist/manifest.json' })

    expect(response.statusCode).toBe(404)
  })
})
