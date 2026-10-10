// services/core/routes/transitionChain.test.ts — GET /overlay/transition-chain 的 vitest 测试（ASSET_PATH 指向临时目录）
//
// 用法：pnpm test
// 配套文件：services/core/routes/transitionChain.ts

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'

describe('GET /overlay/transition-chain', () => {
  const originalAssetPath = process.env.ASSET_PATH
  let tempRoot: string
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mintbot-transition-route-'))
    const dir = path.join(tempRoot, 'characters', 'hero')
    fs.mkdirSync(path.join(dir, 'gifs'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'gifs', 'happy.gif'), '')
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      portraits: { pixel: { emotions: { happy: ['gifs/happy.gif', 'gifs/missing.gif'] } } },
      transitions: { 'poke-neutral': [{ from: 'emotions.happy', durationMs: 1200 }] },
    }))
    process.env.ASSET_PATH = tempRoot
    vi.resetModules()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    if (originalAssetPath === undefined) delete process.env.ASSET_PATH
    else process.env.ASSET_PATH = originalAssetPath
    vi.resetModules()
    fs.rmSync(tempRoot, { recursive: true, force: true })
    warnSpy.mockRestore()
  })

  async function buildApp() {
    const { CHARACTERS_ROOT } = await import('../characters/manifest.js')
    const { transitionChainRoutes } = await import('./transitionChain.js')
    const fastify = Fastify()
    await fastify.register(fastifyStatic, { root: CHARACTERS_ROOT, prefix: '/characters/', decorateReply: false })
    await fastify.register(transitionChainRoutes)
    return fastify
  }

  async function get(query: string) {
    const fastify = await buildApp()
    return fastify.inject({ method: 'GET', url: `/overlay/transition-chain?${query}` })
  }

  it('返回整条链：每步的候选文件、durationMs、pick', async () => {
    const response = await get('characterId=hero&trigger=poke-neutral&form=pixel')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ steps: [{ files: ['gifs/happy.gif'], durationMs: 1200, pick: 'random' }] })
  })

  it('每次请求都从磁盘现读 manifest，改动立刻生效', async () => {
    const fastify = await buildApp()
    fs.writeFileSync(path.join(tempRoot, 'characters', 'hero', 'manifest.json'), JSON.stringify({
      portraits: { pixel: { emotions: { happy: ['gifs/happy.gif'] } } },
      transitions: { 'poke-neutral': [{ from: 'emotions.happy', durationMs: 500 }] },
    }))

    const response = await fastify.inject({ method: 'GET', url: '/overlay/transition-chain?characterId=hero&trigger=poke-neutral&form=pixel' })

    expect(response.json().steps[0].durationMs).toBe(500)
  })

  it('角色不存在、没有这个触发点时返回空链', async () => {
    expect((await get('characterId=nobody&trigger=poke-neutral&form=pixel')).json()).toEqual({ steps: [] })
    expect((await get('characterId=hero&trigger=unknown&form=pixel')).json()).toEqual({ steps: [] })
  })

  it('manifest 不是合法 JSON 时返回空链', async () => {
    fs.writeFileSync(path.join(tempRoot, 'characters', 'hero', 'manifest.json'), '{broken')

    const response = await get('characterId=hero&trigger=poke-neutral&form=pixel')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ steps: [] })
  })

  it('参数缺失或非法时返回 400', async () => {
    for (const query of [
      'trigger=poke-neutral&form=pixel',
      'characterId=&trigger=poke-neutral&form=pixel',
      'characterId=..&trigger=poke-neutral&form=pixel',
      'characterId=a%2Fb&trigger=poke-neutral&form=pixel',
      'characterId=a%5Cb&trigger=poke-neutral&form=pixel',
      'characterId=hero&form=pixel',
      'characterId=hero&trigger=poke-neutral',
      'characterId=hero&trigger=poke-neutral&form=hologram',
    ]) {
      expect((await get(query)).statusCode, query).toBe(400)
    }
  })

  it('/characters/ 下的静态素材仍能访问', async () => {
    const fastify = await buildApp()

    const manifest = await fastify.inject({ method: 'GET', url: '/characters/hero/manifest.json' })
    const gif = await fastify.inject({ method: 'GET', url: '/characters/hero/gifs/happy.gif' })

    expect(manifest.statusCode).toBe(200)
    expect(gif.statusCode).toBe(200)
  })
})
