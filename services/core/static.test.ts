import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { CHARACTERS_ROOT } from './characters/manifest.js'

async function buildTestApp() {
  const fastify = Fastify()
  await fastify.register(fastifyStatic, {
    root: CHARACTERS_ROOT,
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

// ASSET_PATH 配置外置（docs/MintBot_TDD.md §3.5）：静态路由与 services/core/characters/manifest.ts
// 的 loadCharacterManifest 必须共用同一份可配置根路径，而不是两处各自硬编码 'assets/characters'
describe('ASSET_PATH 配置外置：静态路由与 manifest loader 解析同一份根路径', () => {
  it('设置 ASSET_PATH 后，GET /characters/* 与 loadCharacterManifest 都从新的根目录读取', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mintbot-asset-path-'))
    try {
      const dir = path.join(tempRoot, 'characters', 'Override')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ avatar: 'avatar.jpg' }))

      process.env.ASSET_PATH = tempRoot
      vi.resetModules()
      const { CHARACTERS_ROOT: overriddenRoot, loadCharacterManifest } = await import('./characters/manifest.js')

      expect(overriddenRoot).toBe(path.join(tempRoot, 'characters'))

      const fastify = Fastify()
      await fastify.register(fastifyStatic, {
        root: overriddenRoot,
        prefix: '/characters/',
        decorateReply: false,
      })
      const response = await fastify.inject({ method: 'GET', url: '/characters/Override/manifest.json' })
      expect(response.statusCode).toBe(200)

      const manifest = loadCharacterManifest('Override')
      expect(manifest?.avatar).toBe('avatar.jpg')
    } finally {
      delete process.env.ASSET_PATH
      vi.resetModules()
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
